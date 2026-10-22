// canonical source records
export { DOCUMENT_RECORDS, EXAMPLE_SOURCE_RECORDS } from './types.ts';
// source loading and Markdown policy
export {
  canonicalDocuments,
  exampleSources,
  canonicalMarkdownPlugin,
  readDocument,
  resolveDocumentLink,
} from './utilities.ts';
// visitor-facing narrative and source-backed walkthroughs
export { HOME_CONTENT, homeMarkdown } from './home.ts';
export { CONTROL_EXAMPLE, createControlExample, examplesMarkdown } from './examples.ts';
