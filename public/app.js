import {
  validateData, validatePdf, renderSubmissionMarkdown as serializeSubmissionMarkdown,
  parseSubmissionMarkdown, FORM_OPTIONS, FIELD_LIMITS, MAX_PDF_BYTES
} from '../src/validation.js';
import { createPagesStore } from '../src/pages-github.js';
import { zipSync } from 'fflate';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const $ = (id) => document.getElementById(id);
const encoder = new TextEncoder();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEXT_FIELDS = ['fullName', 'email', 'affiliation', 'careerStage', 'field', 'sampleTitle', 'summary', 'goals', 'notes'];
const LABELS = {
  fullName: 'Full name', email: 'Email address', affiliation: 'Affiliation',
  careerStage: 'Career stage', field: 'Field or area', sampleTitle: 'Sample title',
  summary: 'Brief description', goals: 'Your goals', notes: 'Additional notes',
  cv: 'CV', sample: 'Sample', consent: 'Confirmation'
};

// Capture and remove access material before configuration or private requests.
// No access credential, form content, or file is written to browser storage.
function takeAddressAccess() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('access')) return null;
  const value = params.get('access');
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return value || '';
}
let initialAccess = takeAddressAccess();

const state = {
  mode: 'demo', store: null, pendingStore: null, access: null, record: null, receipt: null,
  files: { cv: null, sample: null }, demoId: null, intent: null,
  busy: false, epoch: 0, errors: Object.create(null), generalError: '', currentSection: 'details',
  config: { owner: '', repoPrefix: 'temporary-entry-', maxFileBytes: 2 * 1024 * 1024 }
};
const form = $('submission-form');

function newUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sha256(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function setNotice(message = '') {
  $('page-status').textContent = message;
  $('page-status').hidden = !message;
}

function friendlyError(error) {
  if (error && error.fields && Object.keys(error.fields).length) return 'Please check the highlighted fields.';
  if (error?.code === 'submission_conflict') return 'This submission has changed since you opened it. Load the latest saved version before making another update.';
  if (error?.code === 'authentication' || error?.status === 401 || error?.status === 403) return 'This access code could not open the private submission. Re-enter your code or ask for a new one if it has expired.';
  if (error?.code === 'repository_missing' || error?.status === 404) return 'This private submission is not available. Check your access code or ask the person who provided it for help.';
  if (error?.code === 'repository_guard') return 'This access code does not match a ready private submission. Please ask the person who provided it for help.';
  if (error?.name === 'ValidationError') return error.message;
  if (error?.code === 'invalid_access') return error.message;
  if (error?.code === 'invalid_config') return 'Private access is not configured for this address yet. You can still try the sample.';
  if (error?.status === 429) return 'There have been several requests close together. Wait a moment, then try again.';
  return 'The connection could not complete this request. Your materials may already have arrived. Check the saved status before trying again.';
}

function accessError(message) {
  const error = new Error(message);
  error.code = 'invalid_access';
  return error;
}

function parseAccessCode(raw) {
  let encoded = String(raw || '').trim();
  if (/^https?:\/\//i.test(encoded) || encoded.startsWith('#')) {
    let link;
    try { link = new URL(encoded, location.href); }
    catch (_) { throw accessError('Paste the complete private access code you were given.'); }
    if (link.origin !== location.origin || !['https:', 'http:'].includes(link.protocol)) {
      throw accessError('This link belongs to a different site. Open it at its original address, or paste an access code for this page.');
    }
    encoded = new URLSearchParams(link.hash.slice(1)).get('access') || '';
  }
  if (!/^[A-Za-z0-9_-]{40,4096}$/.test(encoded) || encoded.length % 4 === 1) {
    throw accessError('Paste the complete private access code, rather than an account password or another credential.');
  }
  let parsed;
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_) { throw accessError('This access code is incomplete or unreadable. Please copy it again.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'id,owner,repo,token,v'
    || parsed.v !== 1 || !UUID_RE.test(parsed.id)
    || typeof parsed.owner !== 'string' || parsed.owner.toLowerCase() !== state.config.owner.toLowerCase()
    || parsed.repo !== `${state.config.repoPrefix}${parsed.id}`
    || typeof parsed.token !== 'string' || !/^github_pat_[A-Za-z0-9_]{20,255}$/.test(parsed.token)) {
    throw accessError('This access code is not valid for this page. Use the complete code supplied for your individual submission.');
  }
  return { owner: parsed.owner, repo: parsed.repo, id: parsed.id, token: parsed.token };
}

async function loadConfiguration() {
  const hostnameOwner = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname)?.[1] || '';
  state.config.owner = hostnameOwner;
  try {
    const response = await fetch(new URL('./config.json', location.href), { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('Configuration unavailable.');
    const config = await response.json();
    if (typeof config.owner !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(config.owner)
      || (hostnameOwner && config.owner.toLowerCase() !== hostnameOwner.toLowerCase())
      || config.repoPrefix !== 'temporary-entry-'
      || !Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 32
      || config.maxFileBytes > Math.min(MAX_PDF_BYTES, 2 * 1024 * 1024)) throw new Error('Invalid configuration.');
    state.config = { owner: config.owner, repoPrefix: config.repoPrefix, maxFileBytes: config.maxFileBytes };
  } catch (_) {
    // The local sample always works. Private access uses only the configured
    // owner or the unambiguous owner of an account-level Pages hostname.
    if (!hostnameOwner) state.config.owner = '';
  }
  refreshMode();
}
const configReady = loadConfiguration();

function sizeLabel(bytes) {
  if (!Number.isFinite(Number(bytes))) return '';
  const value = Number(bytes);
  return value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1).replace(/\.0$/, '')} MB`
    : `${Math.max(1, Math.round(value / 1024))} KB`;
}

function fileDescription(file) {
  if (!file) return '';
  const parts = [sizeLabel(file.bytes)];
  if (Number.isInteger(file.pages) && file.pages > 0) parts.push(`${file.pages} ${file.pages === 1 ? 'page' : 'pages'}`);
  return parts.filter(Boolean).join(' · ');
}

function existingFile(kind) { return state.record?.files?.[kind] || null; }
function selectedFile(kind) { return state.files[kind] || null; }

function fileProblem(kind) {
  const file = selectedFile(kind);
  if (!file) return existingFile(kind) ? '' : `Choose a PDF for your ${kind === 'cv' ? 'CV' : 'sample'}.`;
  if (!/\.pdf$/i.test(file.name) || (file.type && !['application/pdf', 'application/x-pdf', 'application/octet-stream'].includes(file.type))) return 'Please choose a PDF file.';
  if (file.size === 0) return 'This file is empty. Choose a PDF with content.';
  if (file.size > state.config.maxFileBytes) return `This file is too large. Choose a PDF up to ${sizeLabel(state.config.maxFileBytes)}.`;
  return '';
}

function renderFile(kind) {
  const chosen = selectedFile(kind);
  const existing = existingFile(kind);
  const hasFile = Boolean(chosen || existing);
  $(kind).required = !hasFile;
  $(`${kind}-card`).classList.toggle('has-file', hasFile);
  $(`${kind}-name`).textContent = chosen ? chosen.name : existing ? existing.name : `Your ${kind === 'cv' ? 'CV' : 'sample'} goes here`;
  $(`${kind}-meta`).textContent = chosen
    ? `${sizeLabel(chosen.size)} · ${existing ? 'Replacement selected' : 'Ready to submit'}`
    : existing ? `${fileDescription(existing)} · Saved file` : 'Choose a PDF from your device';
  $(`${kind}-button-label`).textContent = hasFile ? 'Choose another PDF' : 'Choose PDF';
  $(`${kind}-remove`).hidden = !chosen;
  $(`${kind}-remove`).textContent = existing ? 'Undo replacement' : 'Remove selected file';
  $(`${kind}-help`).textContent = `PDF only · up to ${sizeLabel(state.config.maxFileBytes)}`;
}

function refreshCounts() {
  for (const name of ['summary', 'goals']) $(`${name}-count`).textContent = `${$(name).value.length.toLocaleString()} / ${FIELD_LIMITS[name].toLocaleString()}`;
}

function refreshProgress() {
  const complete = {
    details: ['fullName', 'email', 'affiliation', 'careerStage', 'field'].every((name) => $(name).value.trim() && $(name).validity.valid),
    context: ['sampleTitle', 'summary', 'goals'].every((name) => $(name).value.trim() && $(name).validity.valid),
    files: !fileProblem('cv') && !fileProblem('sample')
  };
  let count = 0;
  for (const [section, done] of Object.entries(complete)) {
    const item = $(`step-${section}`);
    item.classList.toggle('is-complete', Boolean(done));
    item.classList.toggle('is-current', section === state.currentSection);
    item.querySelector('.step-check').hidden = !done;
    if (done) count += 1;
  }
  $('progress-text').textContent = `${count} of 3 sections complete`;
  $('progress-fill').dataset.complete = String(count);
}

function clearFieldError(name) {
  const input = $(name);
  const error = $(`${name}-error`);
  if (input) { input.removeAttribute('aria-invalid'); input.setCustomValidity?.(''); }
  if (error) { error.hidden = true; error.textContent = ''; }
  if (name === 'cv' || name === 'sample') $(`${name}-card`).classList.remove('has-error');
  delete state.errors[name];
}

function setFieldError(name, message) {
  const text = typeof message === 'string' ? message : 'Please check this field.';
  const input = $(name);
  const error = $(`${name}-error`);
  if (input) input.setAttribute('aria-invalid', 'true');
  if (error) { error.textContent = text; error.hidden = false; }
  if (name === 'cv' || name === 'sample') $(`${name}-card`).classList.add('has-error');
  state.errors[name] = text;
}

function renderErrors(focus = false) {
  const list = $('error-summary-list');
  list.replaceChildren();
  for (const [name, message] of Object.entries(state.errors)) {
    const item = document.createElement('li');
    const control = $(name);
    if (control) {
      const link = document.createElement('a');
      link.href = `#${name}`;
      link.textContent = `${LABELS[name] || 'Field'}: ${message}`;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        control.focus();
        if (name === 'cv' || name === 'sample') $(`${name}-card`).scrollIntoView({ block: 'center' });
      });
      item.append(link);
    } else item.textContent = message;
    list.append(item);
  }
  $('error-summary-heading').textContent = Object.keys(state.errors).length ? 'Please check a few details.' : 'We couldn’t complete that just yet.';
  $('error-summary-message').textContent = state.generalError;
  $('error-summary-message').hidden = !state.generalError;
  $('error-summary').hidden = !state.generalError && !Object.keys(state.errors).length;
  if (focus && !$('error-summary').hidden) $('error-summary').focus();
}

function clearErrors() {
  for (const name of Object.keys(LABELS)) clearFieldError(name);
  state.errors = Object.create(null);
  state.generalError = '';
  renderErrors();
}

function readData() {
  const data = {};
  for (const name of TEXT_FIELDS) data[name] = $(name).value;
  data.consent = $('consent').checked;
  return data;
}

function validateForm() {
  clearErrors();
  for (const name of TEXT_FIELDS) {
    const input = $(name);
    if (input.required && !input.value.trim()) input.setCustomValidity('Please complete this field.');
    if (!input.checkValidity()) setFieldError(name, input.validity.typeMismatch && name === 'email' ? 'Enter a valid email address.' : input.tagName === 'SELECT' ? 'Choose an option.' : 'Please complete this field.');
  }
  for (const kind of ['cv', 'sample']) {
    const problem = fileProblem(kind);
    $(kind).setCustomValidity(problem);
    if (!$(kind).checkValidity()) setFieldError(kind, problem || 'Please choose a PDF file.');
  }
  if (!$('consent').checkValidity()) setFieldError('consent', 'Please confirm that you have permission to submit these materials.');
  try { validateData(readData()); }
  catch (error) { for (const [name, message] of Object.entries(error.fields || {})) setFieldError(name, message); }
  renderErrors(true);
  refreshProgress();
  return !Object.keys(state.errors).length;
}

function refreshMode() {
  const live = state.mode === 'live';
  const editing = Boolean(state.record);
  $('demo-banner').hidden = live;
  $('mode-name').textContent = live ? 'Private submission' : 'Sample mode';
  $('mode-description').textContent = live
    ? 'Your private submission is open. Keep your original access code so you can return later.'
    : 'Try the form without uploading anything. Use an access code for a private submission.';
  $('connect-access').hidden = live;
  $('close-session').hidden = !live;
  $('sidebar-note-title').textContent = live ? 'Your code is your way back.' : 'A place to try things.';
  $('sidebar-note-text').textContent = live
    ? 'Re-enter your private access code to return. Anyone with the code can access this submission. This page does not save the code.'
    : 'In sample mode, your details and files stay in this page. Try the example, make changes, and download the result.';
  $('editing-banner').hidden = !editing;
  $('files-description').textContent = editing ? 'Your saved PDFs are shown below. Replacements are optional.' : 'Attach one PDF for each item below.';
  $('submit-label').textContent = state.busy ? 'Preparing your materials…' : live ? (editing ? 'Save changes' : 'Submit materials') : (editing ? 'Update sample' : 'Save sample');
  $('submit-helper').textContent = live ? 'You can return with your original access code.' : 'This sample stays in your browser.';
  for (const kind of ['cv', 'sample']) renderFile(kind);
}

function setBusy(busy, kind = 'submit') {
  state.busy = busy;
  $('form-fields').disabled = busy;
  form.setAttribute('aria-busy', String(busy));
  for (const id of ['open-access-dialog', 'try-sample', 'connect-access', 'close-session', 'edit-submission', 'check-submission', 'reconnect-access', 'receipt-check-status', 'receipt-try-sample', 'receipt-close-session', 'download-package', 'download-cv', 'download-sample', 'download-metadata']) $(id).disabled = busy;
  $('submit-spinner').hidden = !busy || kind !== 'submit';
  $('submit-arrow').hidden = busy && kind === 'submit';
  refreshMode();
}

function populateForm() {
  if (!state.record) return;
  for (const name of TEXT_FIELDS) $(name).value = typeof state.record.data[name] === 'string' ? state.record.data[name] : '';
  $('consent').checked = state.record.data.consent === true;
  state.files = { cv: null, sample: null };
  $('cv').value = '';
  $('sample').value = '';
  clearErrors();
  refreshMode();
  refreshCounts();
  refreshProgress();
}

function adoptRecord(record, receipt = record?.receipt) {
  const expectedId = state.mode === 'live' ? state.access?.id : state.demoId;
  if (!record || record.id !== expectedId || !record.pdfBytes?.cv || !record.pdfBytes?.sample) throw new Error('Invalid saved record.');
  // Canonical serialization is deliberately limited to submission fields.
  // Access credentials cannot enter Markdown or download packages.
  const markdown = serializeSubmissionMarkdown(record);
  const canonical = parseSubmissionMarkdown(markdown);
  state.record = { ...canonical, pdfBytes: record.pdfBytes, version: record.version || '', markdown };
  state.receipt = receipt || { status: state.mode === 'demo' ? 'demo' : 'pending', reference: record.id.slice(0, 8).toUpperCase(), updatedAt: record.submittedAt };
  state.intent = null;
  populateForm();
  $('recovery-panel').hidden = true;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Just now' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function showReceipt(announce = true) {
  const { record, receipt } = state;
  const live = state.mode === 'live';
  const pending = live && receipt.status !== 'merged';
  $('receipt-title').textContent = live ? 'Your materials are in.' : 'Your sample is ready.';
  $('receipt-eyebrow').textContent = live ? 'ALL SET' : 'SAMPLE COMPLETE';
  $('receipt-name').textContent = record.data.fullName;
  $('receipt-email').textContent = record.data.email;
  $('receipt-reference').textContent = record.id.slice(0, 8).toUpperCase();
  $('receipt-date').textContent = formatDate(receipt.updatedAt || record.submittedAt);
  $('receipt-status-text').textContent = live ? (pending ? 'Received' : 'Saved') : 'Browser-only sample';
  $('receipt-message').textContent = live
    ? (pending ? 'Your materials have been received. You can check the saved status below.' : 'Your details and both PDFs are saved. You can return to update them using your original access code.')
    : 'Nothing has been uploaded. Explore the receipt, edit your sample, or download the result.';
  for (const kind of ['cv', 'sample']) {
    $(`receipt-${kind}-name`).textContent = record.files[kind].name;
    $(`receipt-${kind}-meta`).textContent = fileDescription(record.files[kind]);
  }
  const details = $('receipt-details-list');
  details.replaceChildren();
  for (const name of ['affiliation', 'careerStage', 'field', 'sampleTitle', 'summary', 'goals', 'notes']) {
    if (!record.data[name]) continue;
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const definition = document.createElement('dd');
    term.textContent = LABELS[name];
    definition.textContent = record.data[name];
    row.append(term, definition);
    details.append(row);
  }
  $('receipt-access-title').textContent = live ? 'To make changes later' : 'A sample you can explore';
  $('receipt-access-description').textContent = live
    ? 'Keep your original private access code. Re-enter it when you return to edit your details or replace a PDF. Anyone with the code can access this submission. The code is not saved in your browser or included in downloads.'
    : 'Your sample stays in this page. You can edit it and download its two PDFs and details. Refreshing the page clears it.';
  $('receipt-check-status').hidden = !live;
  $('receipt-check-message').textContent = '';
  $('receipt-close-session').hidden = !live;
  $('receipt-bottom-dot').hidden = !live;
  $('receipt-try-sample').textContent = live ? 'Try a sample' : 'Try another sample';
  $('download-status').textContent = '';
  $('form-view').hidden = true;
  $('receipt-view').hidden = false;
  setNotice();
  if (announce) {
    $('receipt-title').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

async function buildIntent() {
  const data = validateData(readData());
  const files = {};
  const pdfBytes = {};
  for (const kind of ['cv', 'sample']) {
    const file = selectedFile(kind);
    if (file) {
      try {
        const checked = await validatePdf(new Uint8Array(await file.arrayBuffer()), file.name, { maxBytes: state.config.maxFileBytes, label: kind === 'cv' ? 'CV' : 'Sample' });
        files[kind] = checked.info;
        pdfBytes[kind] = checked.bytes;
      } catch (error) { error.fields = { ...(error.fields || {}), [kind]: error.message || 'This PDF could not be read. Export it again and retry.' }; throw error; }
    } else {
      files[kind] = state.record.files[kind];
      pdfBytes[kind] = state.record.pdfBytes[kind];
    }
  }
  const id = state.mode === 'live' ? state.access.id : (state.demoId ||= newUuid());
  const now = new Date().toISOString();
  const expectedVersion = state.record?.version || '';
  const record = {
    id, data, files, pdfBytes, editKeyHash: await sha256(id),
    createdAt: state.record?.createdAt || now, submittedAt: now,
    requestId: newUuid(), version: expectedVersion
  };
  record.markdown = serializeSubmissionMarkdown(record);
  return { record, requestId: record.requestId, expectedVersion };
}

async function submitForm(event) {
  event.preventDefault();
  if (state.busy || !validateForm()) return;
  setNotice();
  setBusy(true, 'submit');
  $('submit-status').textContent = 'Checking your details and both PDFs…';
  let attemptedRemoteSave = false;
  const epoch = state.epoch;
  try {
    // Preserve the complete record, including timestamp and bytes, for an
    // unchanged retry. Changing a field or file creates a new intent.
    if (!state.intent) {
      const prepared = await buildIntent();
      if (epoch !== state.epoch) return;
      state.intent = prepared;
    }
    if (epoch !== state.epoch) return;
    const intent = state.intent;
    if (state.mode === 'demo') {
      const version = (await sha256(intent.record.markdown)).slice(0, 40);
      if (epoch !== state.epoch) return;
      adoptRecord({ ...intent.record, version }, { status: 'demo', reference: intent.record.id.slice(0, 8).toUpperCase(), updatedAt: intent.record.submittedAt });
    } else {
      if (!state.store || !state.access) throw accessError('Re-enter your private access code before submitting.');
      $('submit-status').textContent = 'Saving your details and PDFs. Please keep this page open.';
      attemptedRemoteSave = true;
      const result = await state.store.save(intent.record, { expectedVersion: intent.expectedVersion, requestId: intent.requestId });
      if (epoch !== state.epoch) return;
      adoptRecord(result.record, result.receipt);
    }
    $('submit-status').textContent = '';
    showReceipt();
  } catch (error) {
    if (epoch !== state.epoch) return;
    state.generalError = friendlyError(error);
    for (const [name, message] of Object.entries(error.fields || {})) setFieldError(name, message);
    renderErrors(true);
    $('submit-status').textContent = '';
    if (attemptedRemoteSave) {
      $('recovery-description').textContent = error.code === 'submission_conflict'
        ? 'The saved submission has changed. Your edits are still in this page. Loading the latest saved version replaces the details currently in the form; you can then make a new update.'
        : 'Your submission may have arrived before the connection was interrupted. You can retry unchanged materials, or check the saved version. Loading it replaces the details currently in the form.';
      $('recovery-panel').hidden = false;
      $('recovery-status').textContent = '';
    }
  } finally { if (epoch === state.epoch) setBusy(false); }
}

async function checkSavedStatus(fromReceipt = false) {
  if (state.busy || state.mode !== 'live' || !state.store) return;
  const status = $(fromReceipt ? 'receipt-check-message' : 'recovery-status');
  const epoch = state.epoch;
  setBusy(true, 'load');
  status.textContent = 'Checking the saved submission…';
  try {
    const record = await state.store.load();
    if (epoch !== state.epoch) return;
    if (!record) {
      status.textContent = 'No saved materials were found yet. If your previous attempt did not finish, you can try submitting again.';
      return;
    }
    adoptRecord(record);
    showReceipt(!fromReceipt);
    $('receipt-check-message').textContent = state.receipt.status === 'merged' ? 'Your submission is saved.' : 'Received; saving is pending. Check again shortly or contact the person who gave you access.';
  } catch (error) { if (epoch === state.epoch) status.textContent = friendlyError(error); }
  finally { if (epoch === state.epoch) setBusy(false); }
}

function clearSession() {
  // Dropping the store releases its sole in-memory access credential.
  state.epoch += 1;
  state.store?.disconnect();
  state.pendingStore?.disconnect();
  state.store = null;
  state.pendingStore = null;
  state.access = null;
  state.record = null;
  state.receipt = null;
  state.intent = null;
  state.demoId = null;
  state.files = { cv: null, sample: null };
  state.mode = 'demo';
  state.currentSection = 'details';
  form.reset();
  clearErrors();
  $('access-code-input').value = '';
  $('access-code-input').disabled = false;
  $('open-private-submission').disabled = false;
  $('open-private-submission').textContent = 'Open my submission';
  if ($('access-dialog').open) $('access-dialog').close();
  $('access-dialog-error').hidden = true;
  $('recovery-panel').hidden = true;
  $('recovery-status').textContent = '';
  $('submit-status').textContent = '';
  for (const id of ['receipt-name', 'receipt-email', 'receipt-reference', 'receipt-date', 'receipt-cv-name', 'receipt-cv-meta', 'receipt-sample-name', 'receipt-sample-meta', 'receipt-check-message', 'download-status']) $(id).textContent = '';
  $('receipt-details-list').replaceChildren();
  $('receipt-view').hidden = true;
  $('form-view').hidden = false;
  refreshMode();
  refreshCounts();
  refreshProgress();
}

function closeSession() {
  if (state.busy) return;
  clearSession();
  setNotice('Your private session is closed. Re-enter your original access code to open the saved submission again. The form below is now in sample mode.');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function makeSampleFile(kind) {
  const document = await PDFDocument.create();
  document.setTitle(kind === 'cv' ? 'Example CV' : 'Example sample');
  document.setAuthor('Fictional example');
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const heading = kind === 'cv' ? 'Morgan Lee | Example CV' : 'A short example';
  page.drawText(heading, { x: 56, y: 724, size: 22, font: bold, color: rgb(0.15, 0.32, 0.27) });
  const lines = kind === 'cv' ? [
    'Fictional example for trying the submission form.', '',
    'Name: Morgan Lee', 'Email: morgan@example.com', 'Affiliation: Independent', '',
    'Interests', 'Clear explanations, careful analysis, and useful questions.', '',
    'Experience', 'A small example project with a simple dataset.', '',
    'This document contains no real personal information.'
  ] : [
    'Fictional example for trying the submission form.', '',
    'A question', 'How can a small dataset help us explain a familiar pattern?', '',
    'An approach', 'Start with a picture, compare a few summaries, and ask whether',
    'the result changes when the data are grouped in another way.', '',
    'A useful next step', 'Describe what the analysis supports and what remains uncertain.', '',
    'This document is only an example.'
  ];
  let y = 684;
  for (const line of lines) {
    if (line) page.drawText(line, { x: 56, y, size: 11, font, color: rgb(0.26, 0.31, 0.28) });
    y -= 23;
  }
  return new File([await document.save()], kind === 'cv' ? 'example-cv.pdf' : 'example-sample.pdf', { type: 'application/pdf' });
}

async function trySample() {
  if (state.busy) return;
  clearSession();
  const epoch = state.epoch;
  setBusy(true, 'sample');
  setNotice('Preparing a fictional example. Nothing you enter in sample mode is uploaded.');
  try {
    const values = {
      fullName: 'Morgan Lee', email: 'morgan@example.com', affiliation: 'Independent',
      careerStage: 'Doctoral student', field: 'Statistics', sampleTitle: 'A short example',
      summary: 'This example explores a simple question using a small dataset. It is fictional and is included only to try the form.',
      goals: 'I would like feedback on clarity, organization, and how the results are explained.',
      notes: 'A fictional example for testing the submission flow.'
    };
    for (const name of TEXT_FIELDS) $(name).value = values[name] || '';
    const [cv, sample] = await Promise.all([makeSampleFile('cv'), makeSampleFile('sample')]);
    if (epoch !== state.epoch) return;
    state.files = { cv, sample };
    $('consent').checked = false;
    refreshMode();
    refreshCounts();
    refreshProgress();
    setNotice('A fictional example is ready, including both PDFs. Change anything you like, confirm the checkbox, and save the sample.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (_) { if (epoch === state.epoch) setNotice('The example could not be prepared. You can still enter sample details and choose your own PDFs.'); }
  finally { if (epoch === state.epoch) setBusy(false); }
}

function openAccessDialog() {
  if (state.busy) return;
  $('access-code-input').value = '';
  $('access-code-input').removeAttribute('aria-invalid');
  $('access-dialog-error').hidden = true;
  $('access-dialog').showModal();
  $('access-code-input').focus();
}

async function connectAccess(raw, fromAddress = false) {
  if (state.busy) return;
  setBusy(true, 'load');
  $('open-private-submission').disabled = true;
  $('open-private-submission').textContent = 'Opening your submission…';
  $('access-code-input').disabled = true;
  $('access-dialog-error').hidden = true;
  if (fromAddress) setNotice('Opening your private submission…');
  let credentials;
  let pendingStore = null;
  let epoch = state.epoch;
  try {
    await configReady;
    if (epoch !== state.epoch) return;
    if (!state.config.owner) { const error = new Error(); error.code = 'invalid_config'; throw error; }
    credentials = parseAccessCode(raw);
    raw = '';
    const store = createPagesStore({ owner: credentials.owner, repo: credentials.repo, id: credentials.id, token: credentials.token });
    pendingStore = store;
    state.pendingStore = store;
    const identity = { owner: credentials.owner, repo: credentials.repo, id: credentials.id };
    credentials.token = '';
    credentials = null;
    const record = await store.load();
    if (epoch !== state.epoch) return;
    state.pendingStore = null;
    clearSession();
    epoch = state.epoch;
    state.mode = 'live';
    state.store = store;
    pendingStore = null;
    state.access = identity;
    if (record) {
      adoptRecord(record);
      showReceipt();
    } else {
      setNotice('Your private submission is open. Complete the form and attach both PDFs to submit.');
      refreshMode();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if ($('access-dialog').open) $('access-dialog').close();
  } catch (error) {
    raw = '';
    if (credentials) credentials.token = '';
    if (epoch !== state.epoch) return;
    const message = friendlyError(error);
    if (fromAddress) setNotice(message);
    if (!$('access-dialog').open) $('access-dialog').showModal();
    $('access-dialog-error').textContent = message;
    $('access-dialog-error').hidden = false;
  } finally {
    raw = '';
    if (credentials) credentials.token = '';
    if (pendingStore && state.pendingStore === pendingStore) state.pendingStore = null;
    pendingStore?.disconnect();
    if (epoch === state.epoch) {
      $('access-code-input').value = '';
      $('access-code-input').disabled = false;
      $('open-private-submission').disabled = false;
      $('open-private-submission').textContent = 'Open my submission';
      setBusy(false);
    }
  }
}

function editSubmission() {
  if (!state.record || state.busy) return;
  populateForm();
  $('receipt-view').hidden = true;
  $('form-view').hidden = false;
  setNotice();
  $('fullName').focus({ preventScroll: true });
  form.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadFiles(kind) {
  if (!state.record || state.busy) return;
  const record = state.record;
  try {
    if (kind === 'package') {
      const markdown = serializeSubmissionMarkdown(record);
      const bytes = zipSync({
        'cv.pdf': [record.pdfBytes.cv, { level: 0 }],
        'sample.pdf': [record.pdfBytes.sample, { level: 0 }],
        'submission.md': encoder.encode(markdown)
      });
      saveBlob(new Blob([bytes], { type: 'application/zip' }), 'submission.zip');
    } else if (kind === 'metadata') {
      saveBlob(new Blob([serializeSubmissionMarkdown(record)], { type: 'text/markdown;charset=utf-8' }), 'submission.md');
    } else {
      saveBlob(new Blob([record.pdfBytes[kind]], { type: 'application/pdf' }), record.files[kind].name);
    }
    $('download-status').textContent = 'Your download is ready.';
  } catch (_) { $('download-status').textContent = 'The download could not be prepared. Please try again.'; }
}

function fieldChanged(name) {
  clearFieldError(name);
  state.intent = null;
  state.generalError = '';
  renderErrors();
  refreshCounts();
  refreshProgress();
}

form.addEventListener('submit', submitForm);
form.addEventListener('input', (event) => {
  if (Object.hasOwn(LABELS, event.target.id) && event.target.type !== 'file') fieldChanged(event.target.id);
});
form.addEventListener('change', (event) => {
  const name = event.target.id;
  if (!Object.hasOwn(LABELS, name)) return;
  if (name === 'cv' || name === 'sample') {
    state.files[name] = $(name).files?.[0] || null;
    fieldChanged(name);
    renderFile(name);
    const problem = fileProblem(name);
    if (selectedFile(name) && problem) { $(name).setCustomValidity(problem); setFieldError(name, problem); }
    renderErrors();
    refreshProgress();
  } else fieldChanged(name);
});
form.addEventListener('focusin', (event) => {
  const section = event.target.closest('.form-section');
  if (!section) return;
  state.currentSection = { 'your-details': 'details', 'a-little-context': 'context', 'your-files': 'files' }[section.id] || 'details';
  refreshProgress();
});
for (const kind of ['cv', 'sample']) {
  $(`${kind}-remove`).addEventListener('click', () => {
    if (state.busy) return;
    state.files[kind] = null;
    $(kind).value = '';
    fieldChanged(kind);
    renderFile(kind);
    refreshProgress();
    $(kind).focus();
  });
}
for (const id of ['open-access-dialog', 'connect-access', 'reconnect-access']) $(id).addEventListener('click', openAccessDialog);
for (const id of ['try-sample', 'receipt-try-sample']) $(id).addEventListener('click', trySample);
for (const id of ['close-session', 'receipt-close-session']) $(id).addEventListener('click', closeSession);
$('close-access-dialog').addEventListener('click', () => $('access-dialog').close());
$('access-dialog').addEventListener('close', () => { $('access-code-input').value = ''; });
$('access-dialog-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = $('access-code-input').value;
  $('access-code-input').value = '';
  if (!raw.trim()) {
    $('access-dialog-error').textContent = 'Paste your private access code first.';
    $('access-dialog-error').hidden = false;
    $('access-code-input').focus();
    return;
  }
  connectAccess(raw);
});
$('access-code-input').addEventListener('input', () => { $('access-dialog-error').hidden = true; });
$('check-submission').addEventListener('click', () => checkSavedStatus(false));
$('receipt-check-status').addEventListener('click', () => checkSavedStatus(true));
$('edit-submission').addEventListener('click', editSubmission);
for (const [id, kind] of [['download-package', 'package'], ['download-cv', 'cv'], ['download-sample', 'sample'], ['download-metadata', 'metadata']]) $(id).addEventListener('click', () => downloadFiles(kind));

window.addEventListener('hashchange', () => {
  const raw = takeAddressAccess();
  if (raw === null) return;
  if (state.busy) { setNotice('Wait for the current request to finish, then enter your access code again.'); return; }
  connectAccess(raw, true);
});
window.addEventListener('pagehide', () => { clearSession(); initialAccess = null; });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) { setBusy(false); setNotice('This page is in sample mode. Re-enter your private access code to reopen a saved submission.'); }
});

for (const [name, values] of Object.entries(FORM_OPTIONS)) {
  const select = $(name);
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = name === 'careerStage' ? 'Select your career stage' : 'Select your field or area';
  select.append(placeholder);
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
}
for (const [name, limit] of Object.entries(FIELD_LIMITS)) $(name).maxLength = limit;
refreshCounts();
refreshProgress();
setBusy(false);
if (initialAccess !== null) {
  const raw = initialAccess;
  initialAccess = null;
  connectAccess(raw, true);
}
