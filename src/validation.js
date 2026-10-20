import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFInvalidObject,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';

export const FORM_OPTIONS = Object.freeze({
  careerStage: Object.freeze([
    'Undergraduate student',
    "Master's student",
    'Doctoral student',
    'Postdoctoral researcher',
    'Faculty',
    'Other',
  ]),
  field: Object.freeze([
    'Statistics',
    'Mathematics',
    'Computer science',
    'Social sciences',
    'Public health',
    'Other',
  ]),
});

export const FIELD_LIMITS = Object.freeze({
  fullName: 120,
  email: 254,
  affiliation: 200,
  sampleTitle: 160,
  summary: 3000,
  goals: 2000,
  notes: 3000,
});

export const MAX_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;
export const MAX_MARKDOWN_BYTES = 64 * 1024;
export const METADATA_PREFIX = '<!-- temporary-submission-metadata:v1:';
const MAX_FILENAME_LENGTH = 180;
const MAX_PDF_OBJECTS = 25000;
const MAX_PDF_VISITS = 150000;
const MAX_PDF_DEPTH = 128;
const DATA_FIELDS = [...Object.keys(FIELD_LIMITS), 'careerStage', 'field', 'consent'];
const MULTILINE_FIELDS = new Set(['summary', 'goals', 'notes']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

export class ValidationError extends Error {
  constructor(message, code = 'validation_error', fields = {}) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.code = code;
    this.fields = fields;
  }
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, required = allowed) {
  return isRecord(value)
    && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key));
}

/** Validate the JSON form payload. Unknown fields are rejected, never persisted. */
export function validateData(raw) {
  if (!isRecord(raw)) {
    throw new ValidationError('Enter valid submission information.', 'invalid_data');
  }
  const errors = {};
  const unknown = Object.keys(raw).filter((key) => !DATA_FIELDS.includes(key));
  if (unknown.length) errors.form = 'The form contains unexpected fields. Reload the page and try again.';
  const data = {};
  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    const input = Object.hasOwn(raw, field) ? raw[field] : (field === 'notes' ? '' : undefined);
    if (typeof input !== 'string') {
      errors[field] = field === 'notes' ? 'Enter text for this field.' : 'Complete this field.';
      continue;
    }
    const multiline = MULTILINE_FIELDS.has(field);
    let text = input.normalize('NFC');
    if (multiline) text = text.replace(/\r\n?|\u2028|\u2029/g, '\n');
    // Check before trimming, so control characters cannot be hidden at either end.
    const forbidden = multiline
      ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u
      : /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
    if (forbidden.test(text)) {
      errors[field] = 'Remove unsupported control characters from this field.';
      continue;
    }
    text = text.trim();
    if (field !== 'notes' && !text) errors[field] = 'Complete this field.';
    else if (text.length > limit) errors[field] = `Use ${limit} characters or fewer.`;
    data[field] = text;
  }
  for (const [field, choices] of Object.entries(FORM_OPTIONS)) {
    if (typeof raw[field] !== 'string' || !choices.includes(raw[field])) {
      errors[field] = 'Choose an option from the list.';
    } else data[field] = raw[field];
  }
  if (data.email && !isEmail(data.email)) errors.email = 'Enter a valid email address.';
  if (raw.consent !== true) errors.consent = 'Confirm that you agree before submitting.';
  data.consent = raw.consent === true;
  if (Object.keys(errors).length) {
    throw new ValidationError('Check the highlighted fields.', 'invalid_data', errors);
  }
  return data;
}

function isEmail(value) {
  if (value.length > 254 || /[\s<>()[\]\\,;:"]/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => (
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  )) && /^[a-z]{2,63}$/i.test(labels.at(-1));
}

function safePdfFilename(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) {
    throw new ValidationError('Choose a PDF with a valid filename.', 'invalid_pdf_name');
  }
  let name = value.normalize('NFC').replace(/\\/g, '/').split('/').at(-1);
  name = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f<>:"|?*]/gu, '_').trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!/\.pdf$/i.test(name) || name.length <= 4) {
    throw new ValidationError('Choose a file ending in .pdf.', 'invalid_pdf_name');
  }
  if (name.length > MAX_FILENAME_LENGTH) name = `${name.slice(0, MAX_FILENAME_LENGTH - 4)}.pdf`;
  return name;
}

function pdfError(label, message, code = 'invalid_pdf') {
  return new ValidationError(`${label}: ${message}`, code);
}

// Names may use #xx escapes. pdf-lib 1.17.1 leaves some lowercase hex escapes
// undecoded; normalize those conservatively before applying the feature policy.
function pdfName(value) {
  if (!(value instanceof PDFName)) return undefined;
  let decoded = value.decodeText();
  for (let i = 0; i < 4 && /#[0-9a-f]{2}/i.test(decoded); i++) {
    decoded = decoded.replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return decoded.toLowerCase();
}

const FORBIDDEN_PDF_NAMES = new Set([
  'javascript', 'js', 'aa', 'openaction', 'launch', 'gotoe', 'gotor',
  'submitform', 'importdata', 'resetform', 'rendition', 'setocgstate',
  'embeddedfiles', 'embeddedfile', 'ef', 'rf', 'af', 'filespec', 'fileattachment',
  'richmedia', 'richmediacontent', 'richmediasettings', 'movie', 'sound',
  '3d', '3dd', '3da', '3di', '3dv', 'xfa', 'collection', 'encrypt', 'crypt',
  'ffilter', 'fdecodeparms', 'opi',
]);

function resolvePdf(context, value, label) {
  const seen = new Set();
  while (value instanceof PDFRef) {
    if (seen.has(value.toString()) || seen.size > 32) {
      throw pdfError(label, 'The PDF contains a cyclic object reference. Export it again.');
    }
    seen.add(value.toString());
    value = context.lookup(value);
    if (value === undefined) throw pdfError(label, 'The PDF contains a missing object. Export it again.');
  }
  return value;
}

function dictionaryEntries(dict, context, label) {
  const entries = new Map();
  for (const [key, value] of dict.entries()) {
    const name = pdfName(key);
    if (entries.has(name)) throw pdfError(label, 'The PDF has ambiguous dictionary keys. Export it again.');
    entries.set(name, resolvePdf(context, value, label));
  }
  return entries;
}

function validateLinkAction(value, context, label) {
  const dict = resolvePdf(context, value, label);
  if (!(dict instanceof PDFDict)) throw pdfError(label, 'Unsupported PDF action.', 'pdf_active_content');
  const entries = dictionaryEntries(dict, context, label);
  const action = pdfName(entries.get('s'));
  const allowedKeys = action === 'uri' ? ['type', 's', 'uri', 'ismap'] : ['type', 's', 'd'];
  if (!['uri', 'goto'].includes(action) || [...entries.keys()].some((key) => !allowedKeys.includes(key))) {
    throw pdfError(label, 'The PDF contains an active or unsupported action. Export a static PDF.', 'pdf_active_content');
  }
  if (entries.has('type') && pdfName(entries.get('type')) !== 'action') {
    throw pdfError(label, 'The PDF contains an invalid action.', 'pdf_active_content');
  }
  if (action === 'goto') {
    const target = entries.get('d');
    if (!(target instanceof PDFArray || target instanceof PDFName || target instanceof PDFString || target instanceof PDFHexString)) {
      throw pdfError(label, 'The PDF contains an invalid internal link.', 'pdf_active_content');
    }
    return;
  }
  const target = entries.get('uri');
  if (!(target instanceof PDFString || target instanceof PDFHexString)) {
    throw pdfError(label, 'The PDF contains an invalid link.', 'pdf_active_content');
  }
  const uri = target.decodeText();
  let valid = uri.length > 0 && uri.length <= 2048
    && !/[\u0000-\u0020\u007f-\u009f<>\\]/u.test(uri)
    && !/%(?:00|0a|0d)/i.test(uri);
  try {
    const url = new URL(uri);
    valid &&= (/^https?:\/\//i.test(uri) && ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname))
      || (/^mailto:/i.test(uri) && url.protocol === 'mailto:' && Boolean(url.pathname));
  } catch { valid = false; }
  if (entries.has('ismap') && !(entries.get('ismap') instanceof PDFBool)) valid = false;
  if (!valid) throw pdfError(label, 'PDF links must use http, https, mailto, or internal destinations.', 'pdf_active_content');
}

function inspectPdfGraph(document, label) {
  const { context } = document;
  const indirect = context.enumerateIndirectObjects();
  if (indirect.length > MAX_PDF_OBJECTS) throw pdfError(label, 'The PDF is too complex. Export a simpler PDF.', 'pdf_complexity_limit');
  const pending = indirect.map(([, value]) => ({ value, depth: 0 }));
  pending.push({ value: document.catalog, depth: 0 });
  const visited = new Set();
  let visits = 0;
  while (pending.length) {
    if (++visits > MAX_PDF_VISITS) throw pdfError(label, 'The PDF is too complex. Export a simpler PDF.', 'pdf_complexity_limit');
    let { value, depth } = pending.pop();
    value = resolvePdf(context, value, label);
    if (!value || visited.has(value)) continue;
    visited.add(value);
    if (depth > MAX_PDF_DEPTH) throw pdfError(label, 'The PDF has excessive nesting. Export a simpler PDF.', 'pdf_complexity_limit');
    if (value instanceof PDFInvalidObject) throw pdfError(label, 'The PDF has invalid objects. Export it again.');
    if (value instanceof PDFName && FORBIDDEN_PDF_NAMES.has(pdfName(value))) {
      throw pdfError(label, 'The PDF contains scripts, attachments, or another active feature. Export a static PDF.', 'pdf_active_content');
    }
    if (value instanceof PDFStream) {
      const entries = dictionaryEntries(value.dict, context, label);
      // Proper object/xref streams were consumed by the parser. An unconsumed
      // encoded variant could be interpreted differently by another PDF reader.
      if (['objstm', 'xref'].includes(pdfName(entries.get('type')))) {
        throw pdfError(label, 'The PDF contains an unsupported object stream. Export it again.');
      }
      if (entries.has('f')) throw pdfError(label, 'The PDF refers to an external file. Export a static PDF.', 'pdf_active_content');
      pending.push({ value: value.dict, depth: depth + 1 });
    } else if (value instanceof PDFDict) {
      const entries = dictionaryEntries(value, context, label);
      // /Screen is also a passive transparency blend mode; only its annotation
      // subtype is active. /PS denotes a PostScript XObject in this position.
      if (['screen', 'ps'].includes(pdfName(entries.get('subtype')))) {
        throw pdfError(label, 'The PDF contains an active feature. Export a static PDF.', 'pdf_active_content');
      }
      if (pdfName(entries.get('type')) === 'action') validateLinkAction(value, context, label);
      // Tagged-PDF structure attributes also use /A; those are not link actions.
      if (entries.has('a') && pdfName(entries.get('type')) !== 'structelem') validateLinkAction(entries.get('a'), context, label);
      for (const [key, child] of value.entries()) {
        pending.push({ value: key, depth: depth + 1 }, { value: child, depth: depth + 1 });
      }
    } else if (value instanceof PDFArray) {
      for (const child of value.asArray()) pending.push({ value: child, depth: depth + 1 });
    }
  }
}

function countPages(document, label, maxPages) {
  const { context } = document;
  const root = document.catalog.get(PDFName.of('Pages'));
  const pending = [{ value: root, depth: 0 }];
  const seen = new Set();
  let pages = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    const node = resolvePdf(context, value, label);
    if (!(node instanceof PDFDict) || seen.has(node) || depth > MAX_PDF_DEPTH) {
      throw pdfError(label, 'The PDF has an invalid page tree. Export it again.');
    }
    seen.add(node);
    if (seen.size > MAX_PDF_OBJECTS) throw pdfError(label, 'The PDF page tree is too complex.', 'pdf_complexity_limit');
    const type = pdfName(resolvePdf(context, node.get(PDFName.of('Type')), label));
    if (type === 'page') {
      pages += 1;
      if (pages > maxPages) throw pdfError(label, `Use a PDF with no more than ${maxPages} pages.`, 'pdf_page_limit');
    } else if (type === 'pages') {
      const kids = resolvePdf(context, node.get(PDFName.of('Kids')), label);
      const declaredCount = resolvePdf(context, node.get(PDFName.of('Count')), label);
      if (!(kids instanceof PDFArray) || !(declaredCount instanceof PDFNumber)
        || !Number.isSafeInteger(declaredCount.asNumber()) || declaredCount.asNumber() < 0) {
        throw pdfError(label, 'The PDF has an invalid page tree. Export it again.');
      }
      for (const child of kids.asArray()) pending.push({ value: child, depth: depth + 1 });
    } else throw pdfError(label, 'The PDF has an invalid page tree. Export it again.');
  }
  if (!pages) throw pdfError(label, 'The PDF must contain at least one page.', 'pdf_page_limit');
  if (document.getPages().length !== pages) throw pdfError(label, 'The PDF page count is inconsistent. Export it again.');
  return pages;
}

/**
 * Structural validation, not malware certification. This parses objects (including
 * ordinary object streams), checks common active features, and keeps original bytes.
 * It neither executes nor rasterizes PDFs, and is not an antivirus/sandbox service.
 */
export async function validatePdf(input, name, { maxBytes = MAX_PDF_BYTES, maxPages = MAX_PDF_PAGES, label = 'Document' } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PDF_BYTES
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PDF_PAGES) {
    throw new TypeError('PDF limits must be positive integers within the supported maximums.');
  }
  const safeName = safePdfFilename(name);
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else throw pdfError(label, 'Choose a valid PDF file.');
  if (bytes.byteLength > maxBytes) throw pdfError(label, `The file exceeds the ${Math.ceil(maxBytes / 1024 / 1024)} MiB limit.`, 'pdf_too_large');
  const header = String.fromCharCode(...bytes.subarray(0, 12));
  const tail = String.fromCharCode(...bytes.subarray(Math.max(0, bytes.length - 1024)));
  if (bytes.length < 32 || !/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.test(header)
    || !/(?:\r|\n)%%EOF[\x09\x0a\x0c\x0d\x20]*$/.test(tail)) {
    throw pdfError(label, 'This is not a complete PDF. Export it as PDF and try again.');
  }
  try {
    const document = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    if (document.isEncrypted || document.context.trailerInfo.Encrypt !== undefined) {
      throw pdfError(label, 'Use a PDF without a password or encryption.', 'pdf_encrypted');
    }
    inspectPdfGraph(document, label);
    const pages = countPages(document, label, maxPages);
    return { bytes, info: { name: safeName, bytes: bytes.byteLength, pages } };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    if (/encrypt/i.test(error?.name ?? '') || /encrypted/i.test(error?.message ?? '')) {
      throw pdfError(label, 'Use a PDF without a password or encryption.', 'pdf_encrypted');
    }
    throw pdfError(label, 'The PDF could not be read safely. Export a new PDF and try again.');
  }
}

function metadataError() {
  return new ValidationError('The stored submission record is invalid.', 'invalid_submission_record');
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function canonicalRecord(record) {
  if (!isRecord(record) || typeof record.id !== 'string' || !UUID.test(record.id)
    || typeof record.requestId !== 'string' || !UUID.test(record.requestId)
    || typeof record.editKeyHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.editKeyHash)
    || !isIsoDate(record.createdAt) || !isIsoDate(record.submittedAt)
    || record.createdAt > record.submittedAt) throw metadataError();
  const data = validateData(record.data);
  if (!exactKeys(record.files, ['cv', 'sample'])) throw metadataError();
  const files = {};
  for (const key of ['cv', 'sample']) {
    const file = record.files[key];
    if (!exactKeys(file, ['name', 'bytes', 'pages']) || typeof file.name !== 'string'
      || !Number.isSafeInteger(file.bytes) || file.bytes < 32 || file.bytes > MAX_PDF_BYTES
      || !Number.isSafeInteger(file.pages) || file.pages < 1 || file.pages > MAX_PDF_PAGES) throw metadataError();
    const name = safePdfFilename(file.name);
    if (name !== file.name) throw metadataError();
    files[key] = { name, bytes: file.bytes, pages: file.pages };
  }
  // Deliberately select fields: caller-side buffers or a private edit key must
  // never be serialized, even if the caller supplies them on the same object.
  return {
    schemaVersion: 1,
    id: record.id,
    data,
    files,
    editKeyHash: record.editKeyHash,
    submittedAt: record.submittedAt,
    createdAt: record.createdAt,
    requestId: record.requestId,
  };
}

function toBase64Url(text) {
  const bytes = encoder.encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  if (!/^[a-z0-9_-]+$/i.test(value) || value.length % 4 === 1) throw metadataError();
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (toBase64Url(text) !== value) throw metadataError();
  return text;
}

// Entity escaping makes even HTML comments, tables, code fences, links, and
// heading markers remain applicant text when GitHub renders this Markdown.
function escapeMarkdown(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+\-.!|~=]/g, (character) => `\\${character}`);
}

function quoted(value) {
  return (value || 'None provided.').split('\n').map((line) => `> ${escapeMarkdown(line)}`).join('\n');
}

export function renderSubmissionMarkdown(record) {
  const metadata = canonicalRecord(record);
  const { id, data, files, createdAt, submittedAt, requestId } = metadata;
  const lines = [
    '# Submission', '',
    `Submission ID: \`${id}\`  `,
    `Created: ${createdAt}  `,
    `Last submitted: ${submittedAt}  `,
    `Request ID: \`${requestId}\``, '',
    '## Information', '',
    '| Field | Response |',
    '| --- | --- |',
    ...[
      ['Full name', data.fullName], ['Email', data.email], ['Affiliation', data.affiliation],
      ['Career stage', data.careerStage], ['Field', data.field], ['Sample title', data.sampleTitle],
      ['Consent to submission and storage', 'Confirmed'],
    ].map(([label, value]) => `| ${label} | ${escapeMarkdown(value)} |`), '',
    '## Summary', '', quoted(data.summary), '',
    '## Goals', '', quoted(data.goals), '',
    '## Additional notes', '', quoted(data.notes), '',
    '## Documents', '',
    '| Document | Original filename | Bytes | Pages |',
    '| --- | --- | ---: | ---: |',
    `| [CV](cv.pdf) | ${escapeMarkdown(files.cv.name)} | ${files.cv.bytes} | ${files.cv.pages} |`,
    `| [Writing sample](sample.pdf) | ${escapeMarkdown(files.sample.name)} | ${files.sample.bytes} | ${files.sample.pages} |`, '',
    `${METADATA_PREFIX}${toBase64Url(JSON.stringify(metadata))} -->`, '',
  ];
  const markdown = lines.join('\n');
  if (encoder.encode(markdown).length > MAX_MARKDOWN_BYTES) throw metadataError();
  return markdown;
}

/** Read only the one canonical metadata record, never interpret the prose. */
export function parseSubmissionMarkdown(markdown) {
  try {
    if (typeof markdown !== 'string' || encoder.encode(markdown).length > MAX_MARKDOWN_BYTES) throw metadataError();
    const starts = markdown.match(/<!--\s*temporary-submission-metadata:/g) ?? [];
    const matches = [...markdown.matchAll(/^<!-- temporary-submission-metadata:v1:([A-Za-z0-9_-]+) -->$/gm)];
    if (starts.length !== 1 || matches.length !== 1) throw metadataError();
    const match = matches[0];
    if (!['', '\n'].includes(markdown.slice(match.index + match[0].length))) throw metadataError();
    const json = fromBase64Url(match[1]);
    const raw = JSON.parse(json);
    if (!exactKeys(raw, ['schemaVersion', 'id', 'data', 'files', 'editKeyHash', 'submittedAt', 'createdAt', 'requestId'])
      || raw.schemaVersion !== 1) throw metadataError();
    const canonical = canonicalRecord(raw);
    // Canonical serialization rejects duplicate JSON keys and silently-normalized
    // values; one record has exactly one accepted byte representation.
    if (JSON.stringify(canonical) !== json) throw metadataError();
    const { schemaVersion: _version, ...record } = canonical;
    return record;
  } catch (error) {
    if (error instanceof ValidationError && error.code === 'invalid_submission_record') throw error;
    throw metadataError();
  }
}
