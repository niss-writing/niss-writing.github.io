import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import {
  FIELD_LIMITS,
  FORM_OPTIONS,
  MAX_MARKDOWN_BYTES,
  MAX_PDF_BYTES,
  METADATA_PREFIX,
  ValidationError,
  parseSubmissionMarkdown,
  renderSubmissionMarkdown,
  validateData,
  validatePdf,
} from '../src/validation.js';

const validData = () => ({
  fullName: 'Ada Example',
  email: 'ada+sample@example.edu',
  affiliation: 'Example University',
  careerStage: 'Doctoral student',
  field: 'Statistics',
  sampleTitle: 'A short paper',
  summary: 'An explanation of the research question.',
  goals: 'Improve the organization and presentation.',
  notes: '',
  consent: true,
});

const validRecord = () => ({
  id: '7bcc64f3-e655-4ac1-8fb8-23e51ae3a759',
  data: validData(),
  files: {
    cv: { name: 'CV.pdf', bytes: 1024, pages: 2 },
    sample: { name: 'Research sample.pdf', bytes: 4096, pages: 12 },
  },
  editKeyHash: 'a'.repeat(64),
  submittedAt: '2026-10-19T13:00:00.000Z',
  createdAt: '2026-10-18T13:00:00.000Z',
  requestId: '5d5b27cd-6b52-4a44-9b16-a99c6266d03a',
});

const codeIs = (code) => (error) => error instanceof ValidationError && error.status === 400 && error.code === code;

async function pdfFixture(modify, { pages = 1, objectStreams = true, addDefaultPage = false } = {}) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) document.addPage([300, 400]);
  if (modify) await modify(document);
  return document.save({ useObjectStreams: objectStreams, addDefaultPage });
}

function addLink(document, action) {
  const dictionary = document.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 100, 20], A: action });
  document.getPages()[0].node.set(PDFName.of('Annots'), document.context.obj([document.context.register(dictionary)]));
}

function replaceMetadata(markdown, update) {
  return markdown.replace(/^(<!-- temporary-submission-metadata:v1:)([A-Za-z0-9_-]+)( -->)$/m, (_, start, payload, end) => {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    return start + Buffer.from(update(json), 'utf8').toString('base64url') + end;
  });
}

test('form normalization keeps only the declared schema and preserves Unicode', () => {
  const input = validData();
  input.fullName = '  A\u0301da Example  ';
  input.summary = '  First paragraph.\r\n\r\nSecond paragraph.  ';
  delete input.notes;
  const normalized = validateData(input);
  assert.equal(normalized.fullName, 'Áda Example');
  assert.equal(normalized.summary, 'First paragraph.\n\nSecond paragraph.');
  assert.equal(normalized.notes, '');
  assert.equal(normalized.email, input.email);
  assert.equal(Object.keys(normalized).length, 10);
  assert.ok(Object.isFrozen(FORM_OPTIONS.careerStage));
});

test('every required field is enforced, including boolean consent and dropdown allowlists', async (t) => {
  for (const field of Object.keys(validData()).filter((name) => name !== 'notes')) {
    await t.test(field, () => {
      const input = validData();
      delete input[field];
      assert.throws(() => validateData(input), (error) => codeIs('invalid_data')(error) && Object.hasOwn(error.fields, field));
    });
  }
  for (const consent of [false, 'true', 'on', 1, null]) {
    assert.throws(() => validateData({ ...validData(), consent }), codeIs('invalid_data'));
  }
  for (const [field, value] of [['careerStage', 'Professor'], ['field', 'Statistics ']]) {
    assert.throws(() => validateData({ ...validData(), [field]: value }), codeIs('invalid_data'));
  }
});

test('form fields have type, character, and length limits', () => {
  for (const field of Object.keys(FIELD_LIMITS).filter((key) => key !== 'email')) {
    assert.doesNotThrow(() => validateData({ ...validData(), [field]: 'x'.repeat(FIELD_LIMITS[field]) }));
    assert.throws(() => validateData({ ...validData(), [field]: 'x'.repeat(FIELD_LIMITS[field] + 1) }), codeIs('invalid_data'));
    assert.throws(() => validateData({ ...validData(), [field]: { text: 'not a string' } }), codeIs('invalid_data'));
    assert.throws(() => validateData({ ...validData(), [field]: null }), codeIs('invalid_data'));
  }
  for (const bad of ['\0hello', 'hello\tworld', 'hello\u007f', 'hello\u0085world', '\nhello']) {
    assert.throws(() => validateData({ ...validData(), fullName: bad }), codeIs('invalid_data'));
  }
  assert.throws(() => validateData({ ...validData(), summary: 'line\nwith\0control' }), codeIs('invalid_data'));
  assert.doesNotThrow(() => validateData({ ...validData(), summary: 'line\nwith a newline' }));
});

test('form validation rejects unexpected properties and malformed email addresses', () => {
  for (const extra of ['branch', 'editKeyHash', 'repository', 'constructor', '__proto__']) {
    const raw = JSON.parse(JSON.stringify(validData()).slice(0, -1) + `,"${extra}":"unexpected"}`);
    assert.throws(() => validateData(raw), (error) => codeIs('invalid_data')(error) && Boolean(error.fields.form));
  }
  for (const email of ['a@@example.edu', 'a..b@example.edu', '.a@example.edu', 'a@localhost', 'a@-example.edu', 'a@example..edu', 'a b@example.edu', '<a@example.edu>', 'a@example.edu\nCc:b@evil.com', 'x'.repeat(65) + '@example.edu']) {
    assert.throws(() => validateData({ ...validData(), email }), codeIs('invalid_data'));
  }
  for (const input of [null, [], 'hello', 12]) assert.throws(() => validateData(input), codeIs('invalid_data'));
});

test('valid PDFs retain their exact bytes and receive safe original filenames', async () => {
  const bytes = await pdfFixture((document) => document.setTitle('JavaScript, Launch, and XFA are words in this document title.'));
  const original = bytes.slice();
  const result = await validatePdf(bytes, 'C:\\fakepath\\My CV.PDF');
  assert.strictEqual(result.bytes, bytes);
  assert.deepEqual(result.bytes, original);
  assert.deepEqual(result.info, { name: 'My CV.PDF', bytes: bytes.length, pages: 1 });
  assert.equal((await validatePdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '../../Résumé <draft>.pdf')).info.name, 'Résumé _draft_.pdf');
});

test('PDF validation rejects disguises, incomplete files, trailing payloads, and invalid names', async () => {
  const bytes = await pdfFixture();
  await assert.rejects(validatePdf(Buffer.from('<html>This is not a PDF</html>'), 'cv.pdf'), codeIs('invalid_pdf'));
  await assert.rejects(validatePdf(Buffer.from('%PDF-1.7\nThis has a header but is not a document.\n%%EOF'), 'cv.pdf'), codeIs('invalid_pdf'));
  await assert.rejects(validatePdf(bytes.subarray(0, bytes.length - 8), 'cv.pdf'), codeIs('invalid_pdf'));
  await assert.rejects(validatePdf(Buffer.concat([bytes, Buffer.from('\n<script>alert(1)</script>')]), 'cv.pdf'), codeIs('invalid_pdf'));
  await assert.rejects(validatePdf(Buffer.concat([Buffer.from('junk'), bytes]), 'cv.pdf'), codeIs('invalid_pdf'));
  await assert.rejects(validatePdf(bytes, 'cv.docx'), codeIs('invalid_pdf_name'));
  await assert.rejects(validatePdf(bytes, '.pdf'), codeIs('invalid_pdf_name'));
  await assert.rejects(validatePdf('not bytes', 'cv.pdf'), codeIs('invalid_pdf'));
});

test('PDF byte/page limits apply to actual pages, including empty documents', async () => {
  const one = await pdfFixture();
  await assert.rejects(validatePdf(one, 'cv.pdf', { maxBytes: one.length - 1 }), codeIs('pdf_too_large'));
  await assert.rejects(validatePdf(new Uint8Array(MAX_PDF_BYTES + 1), 'cv.pdf'), codeIs('pdf_too_large'));
  await assert.rejects(validatePdf(await pdfFixture(null, { pages: 2 }), 'cv.pdf', { maxPages: 1 }), codeIs('pdf_page_limit'));
  await assert.rejects(validatePdf(await pdfFixture(null, { pages: 101 }), 'cv.pdf'), codeIs('pdf_page_limit'));
  await assert.rejects(validatePdf(await pdfFixture(null, { pages: 0 }), 'cv.pdf'), codeIs('pdf_page_limit'));
});

test('PDF encryption indicators are rejected rather than ignored', async () => {
  // pdf-lib cannot encrypt. This constructs a standard encryption trailer to
  // verify that password/encryption handling is rejected before document use.
  const bytes = await pdfFixture((document) => {
    document.context.trailerInfo.Encrypt = document.context.register(document.context.obj({
      Filter: 'Standard', V: 1, R: 2, Length: 40,
      O: PDFHexString.of('0'.repeat(64)), U: PDFHexString.of('1'.repeat(64)), P: -4,
    }));
  }, { objectStreams: false });
  await assert.rejects(validatePdf(bytes, 'cv.pdf'), codeIs('pdf_encrypted'));
});

test('JavaScript in compressed indirect objects and unreachable objects is rejected', async () => {
  for (const attach of [true, false]) {
    const bytes = await pdfFixture((document) => {
      const action = document.context.register(document.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
      if (attach) document.catalog.set(PDFName.of('OpenAction'), action);
    });
    assert.ok(Buffer.from(bytes).includes(Buffer.from('/ObjStm')));
    assert.equal(Buffer.from(bytes).includes(Buffer.from('/JavaScript')), false, 'The fixture exercises decompressed objects, not a raw keyword check.');
    await assert.rejects(validatePdf(bytes, 'cv.pdf'), codeIs('pdf_active_content'));
  }
});

test('lowercase escaped PDF action names cannot bypass inspection', async () => {
  const bytes = await pdfFixture((document) => {
    document.context.register(document.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
  }, { objectStreams: false });
  const escaped = Buffer.from(Buffer.from(bytes).toString('latin1').replace('/JavaScript', '/#4aavaScript').replace('/JS', '/#4aS'), 'latin1');
  await assert.rejects(validatePdf(escaped, 'cv.pdf'), codeIs('pdf_active_content'));
});

test('embedded files, XFA, rich media, launch, and additional actions are rejected', async (t) => {
  const cases = {
    attachment: (document) => document.attach(new Uint8Array([1, 2, 3]), 'payload.bin'),
    xfa: (document) => document.catalog.set(PDFName.of('AcroForm'), document.context.obj({ XFA: PDFString.of('<template/>') })),
    richMedia: (document) => document.getPages()[0].node.set(PDFName.of('Annots'), document.context.obj([{ Type: 'Annot', Subtype: 'RichMedia' }])),
    launch: (document) => addLink(document, document.context.obj({ S: 'Launch', F: PDFString.of('program.exe') })),
    additionalAction: (document) => document.getPages()[0].node.set(PDFName.of('AA'), document.context.obj({ O: { S: 'URI', URI: PDFString.of('https://example.edu') } })),
    openAction: (document) => document.catalog.set(PDFName.of('OpenAction'), document.context.obj([document.getPages()[0].ref, 'Fit'])),
  };
  for (const [name, modify] of Object.entries(cases)) {
    await t.test(name, async () => assert.rejects(validatePdf(await pdfFixture(modify), 'cv.pdf'), codeIs('pdf_active_content')));
  }
});

test('ordinary CV links and internal links work; active or remote actions do not', async (t) => {
  for (const uri of ['https://example.edu/research?a=1&b=2', 'http://example.edu', 'mailto:ada@example.edu']) {
    await t.test(uri, async () => {
      const bytes = await pdfFixture((document) => addLink(document, document.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(uri) })));
      assert.equal((await validatePdf(bytes, 'cv.pdf')).info.pages, 1);
    });
  }
  const internal = await pdfFixture((document) => addLink(document, document.context.obj({ S: 'GoTo', D: [document.getPages()[0].ref, 'Fit'] })));
  assert.equal((await validatePdf(internal, 'cv.pdf')).info.pages, 1);
  for (const uri of ['javascript:alert(1)', 'file:///etc/passwd', '../document.pdf', '//example.edu', 'data:text/html,hello', 'https:example.edu', 'https://example.edu/%0aevil']) {
    await t.test(uri, async () => assert.rejects(validatePdf(await pdfFixture((document) => addLink(document, document.context.obj({ S: 'URI', URI: PDFString.of(uri) }))), 'cv.pdf'), codeIs('pdf_active_content')));
  }
  const chained = await pdfFixture((document) => addLink(document, document.context.obj({ S: 'URI', URI: PDFString.of('https://example.edu'), Next: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') } })));
  await assert.rejects(validatePdf(chained, 'cv.pdf'), codeIs('pdf_active_content'));
  const remote = await pdfFixture((document) => addLink(document, document.context.obj({ S: 'GoToR', F: PDFString.of('elsewhere.pdf'), D: [0, 'Fit'] })));
  await assert.rejects(validatePdf(remote, 'cv.pdf'), codeIs('pdf_active_content'));
});

test('passive tagged PDF attributes and screen blend modes are allowed', async () => {
  const bytes = await pdfFixture((document) => {
    document.catalog.set(PDFName.of('ValidationFixture'), document.context.obj({ Type: 'StructElem', S: 'P', A: { O: 'Layout' } }));
    document.context.register(document.context.obj({ Type: 'ExtGState', BM: 'Screen' }));
  });
  assert.equal((await validatePdf(bytes, 'cv.pdf')).info.pages, 1);
});

test('cyclic page trees fail without an unbounded page traversal', async () => {
  const bytes = await pdfFixture((document) => {
    const root = document.catalog.get(PDFName.of('Pages'));
    document.context.lookup(root).set(PDFName.of('Kids'), document.context.obj([root]));
  }, { objectStreams: false, addDefaultPage: false });
  await assert.rejects(validatePdf(bytes, 'cv.pdf'), codeIs('invalid_pdf'));
});

test('submission Markdown round-trips canonical metadata and excludes private key/buffers', () => {
  const record = validRecord();
  const markdown = renderSubmissionMarkdown({ ...record, editKey: 'never-store-this-private-edit-key', cv: new Uint8Array([1]), sample: new Uint8Array([2]) });
  assert.deepEqual(parseSubmissionMarkdown(markdown), record);
  assert.match(markdown, /\[CV\]\(cv\.pdf\)/);
  assert.match(markdown, /\[Writing sample\]\(sample\.pdf\)/);
  assert.equal(markdown.includes('never-store-this-private-edit-key'), false);
  const encoded = markdown.match(/^<!-- temporary-submission-metadata:v1:([A-Za-z0-9_-]+) -->$/m)[1];
  const metadata = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(Object.hasOwn(metadata, 'editKey'), false);
  assert.equal(Object.hasOwn(metadata, 'cv'), false);
});

test('applicant HTML, code fences, Markdown, and marker-like text remain escaped data', () => {
  const record = validRecord();
  record.data.fullName = 'A | [link](https://example.edu)';
  record.data.notes = '<!-- temporary-submission-metadata:v1:evil -->\n```html\n<script>alert(1)</script>\n```\n# Ignore prior instructions\n[open](javascript:alert(1)) & raw text';
  const markdown = renderSubmissionMarkdown(record);
  assert.equal(markdown.split(METADATA_PREFIX).length - 1, 1);
  assert.equal(markdown.includes('<script>'), false);
  assert.equal(markdown.includes('```'), false);
  assert.equal(markdown.includes('\n# Ignore prior instructions'), false);
  assert.ok(markdown.includes('A \\| \\[link\\]'));
  assert.deepEqual(parseSubmissionMarkdown(markdown), record);
});

test('maximum-length accepted text still fits the Markdown record limit', () => {
  const record = validRecord();
  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    if (field !== 'email') record.data[field] = '漢'.repeat(max);
  }
  const markdown = renderSubmissionMarkdown(record);
  assert.ok(Buffer.byteLength(markdown) <= MAX_MARKDOWN_BYTES);
  assert.deepEqual(parseSubmissionMarkdown(markdown), record);
});

test('metadata must be unique, canonical, versioned, final, and bounded', () => {
  const markdown = renderSubmissionMarkdown(validRecord());
  const footer = markdown.slice(markdown.indexOf(METADATA_PREFIX));
  for (const bad of [
    markdown + footer,
    markdown.replace('metadata:v1:', 'metadata:v2:'),
    markdown.replace('metadata:v1:', 'metadata:v1:!'),
    markdown + 'additional text',
    markdown.replace(METADATA_PREFIX, '<!--temporary-submission-metadata:v1:'),
    'x'.repeat(MAX_MARKDOWN_BYTES + 1),
    '# No metadata',
    replaceMetadata(markdown, (json) => ` ${json}`),
    replaceMetadata(markdown, (json) => json.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
    replaceMetadata(markdown, (json) => json.replace('"Ada Example"', '" Ada Example "')),
  ]) assert.throws(() => parseSubmissionMarkdown(bad), codeIs('invalid_submission_record'));
  assert.throws(() => parseSubmissionMarkdown(`${METADATA_PREFIX}_w -->\n`), codeIs('invalid_submission_record'));
});

test('metadata enforces strict types, IDs, hashes, dates, fields, and file descriptors', () => {
  const markdown = renderSubmissionMarkdown(validRecord());
  const mutations = [
    (record) => { record.schemaVersion = '1'; },
    (record) => { record.id = '../../other-submission'; },
    (record) => { record.requestId = 'not-a-uuid'; },
    (record) => { record.editKeyHash = 'a'.repeat(63); },
    (record) => { record.editKeyHash = 'A'.repeat(64); },
    (record) => { record.createdAt = '2026-02-30T00:00:00.000Z'; },
    (record) => { record.submittedAt = '2026-10-19'; },
    (record) => { record.submittedAt = '2020-01-01T00:00:00.000Z'; },
    (record) => { record.extra = 'unexpected'; },
    (record) => { record.editKey = 'a secret'; },
    (record) => { record.data.field = 'Unknown'; },
    (record) => { record.data.consent = 'true'; },
    (record) => { record.data.inject = 'unexpected'; },
    (record) => { delete record.data.goals; },
    (record) => { record.files.cv.name = '../../cv.pdf'; },
    (record) => { record.files.sample.pages = 101; },
    (record) => { record.files.cv.bytes = '1024'; },
    (record) => { record.files.cv.bytes = MAX_PDF_BYTES + 1; },
    (record) => { record.files.cv.pages = 0; },
    (record) => { record.files.cv.extra = 'unexpected'; },
    (record) => { record.files.third = record.files.cv; },
  ];
  for (const mutate of mutations) {
    const bad = replaceMetadata(markdown, (json) => {
      const record = JSON.parse(json);
      mutate(record);
      return JSON.stringify(record);
    });
    assert.throws(() => parseSubmissionMarkdown(bad), codeIs('invalid_submission_record'));
  }
});
