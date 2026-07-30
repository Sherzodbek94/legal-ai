import type { JsonSchemaSpec } from '../providers/llm-provider.interface';

/** Shape the model is constrained to emit for a generated legal document. */
export interface LegalDocumentDraft {
  title: string;
  documentType: string;
  language: string;
  sections: LegalDocumentSection[];
  /** Fields the model could not fill from the supplied data. */
  missingFields: string[];
  /** Points a reviewing attorney should check. */
  reviewNotes: string[];
}

export interface LegalDocumentSection {
  heading: string;
  body: string;
  /** 1-based ordinal as it appears in the document. */
  order: number;
}

/**
 * Passed to both providers for native constrained decoding.
 *
 * `additionalProperties: false` and a complete `required` list are mandatory
 * for OpenAI strict mode, and Anthropic applies the same subset — so the one
 * schema serves both without branching.
 */
export const LEGAL_DOCUMENT_JSON_SCHEMA: JsonSchemaSpec = {
  name: 'legal_document_draft',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      documentType: { type: 'string' },
      language: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            body: { type: 'string' },
            order: { type: 'integer' },
          },
          required: ['heading', 'body', 'order'],
          additionalProperties: false,
        },
      },
      missingFields: { type: 'array', items: { type: 'string' } },
      reviewNotes: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'title',
      'documentType',
      'language',
      'sections',
      'missingFields',
      'reviewNotes',
    ],
    additionalProperties: false,
  },
};
