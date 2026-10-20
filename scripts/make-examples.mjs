import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(import.meta.dirname, '..', 'examples');
await mkdir(directory, { recursive: true });
const examples = [
  {
    file: 'example-cv.pdf', title: 'Example CV', subtitle: 'A fictional document for testing uploads.',
    sections: [
      ['EXAMPLE PERSON', 'Example organization', 'example@example.test'],
      ['EDUCATION', '2024 - Present | Doctoral student', 'A fictional degree at an example organization.'],
      ['EXPERIENCE', '2022 - 2024 | Research assistant', 'A fictional role used only to exercise the submission system.'],
      ['INTERESTS', 'Research methods, clear explanations, and useful experiments.'],
    ],
  },
  {
    file: 'example-sample.pdf', title: 'Example sample', subtitle: 'A fictional document for testing uploads.',
    sections: [
      ['A SMALL EXAMPLE', 'This document stands in for a sample supplied by a tester.', 'It contains no real participant information.'],
      ['OVERVIEW', 'A clear question is a useful starting point for an analysis.', 'The next step is to decide which observations would address it.', 'The example stops here: its purpose is to test file handling.'],
      ['TRY AN UPDATE', 'Submit this file with the example CV. Then reopen your private', 'return link, change a form answer, and keep both existing PDFs.', 'You can also replace this file to test a document revision.'],
    ],
  },
];
for (const example of examples) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  const ink = rgb(0.10, 0.17, 0.17);
  const teal = rgb(0.15, 0.38, 0.35);
  page.drawRectangle({ x: 0, y: 744, width: 612, height: 48, color: rgb(0.93, 0.95, 0.92) });
  page.drawText('TEMPORARY FOR NOW  /  TEST DOCUMENT', { x: 48, y: 764, size: 10, font: bold, color: teal });
  page.drawText(example.title, { x: 48, y: 698, size: 30, font: bold, color: ink });
  page.drawText(example.subtitle, { x: 48, y: 674, size: 12, font: regular, color: ink });
  let y = 615;
  for (const [heading, ...lines] of example.sections) {
    page.drawText(heading, { x: 48, y, size: 10, font: bold, color: teal });
    y -= 25;
    for (const line of lines) {
      page.drawText(line, { x: 48, y, size: 11, font: regular, color: ink });
      y -= 18;
    }
    y -= 28;
  }
  page.drawLine({ start: { x: 48, y: 72 }, end: { x: 564, y: 72 }, thickness: 0.5, color: rgb(0.75, 0.80, 0.78) });
  page.drawText('Fictional example. Safe to use for a test submission.', { x: 48, y: 53, size: 9, font: regular, color: teal });
  doc.setTitle(example.title);
  doc.setAuthor('Temporary for now');
  await writeFile(resolve(directory, example.file), await doc.save());
}
console.log('Created examples/example-cv.pdf and examples/example-sample.pdf.');
