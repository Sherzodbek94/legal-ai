import type { JsonSchemaSpec } from '../providers/llm-provider.interface';

/**
 * A drafted *template*, as distinct from a drafted document.
 *
 * The difference is the whole point. A document is finished text; a template is
 * text with holes in it plus a declaration of what fills each hole. Asking the
 * model for a document and then hunting for the variable-shaped parts
 * afterwards does not work — it invents a party name, and nothing downstream
 * can tell that "ACME LEGAL MCHJ" was meant to be a placeholder.
 *
 * So the model declares both halves in one answer, and `validateTemplateDraft`
 * checks they agree.
 */
export interface TemplateVariableDraft {
  key: string;
  label: string;
  type: 'string' | 'text' | 'number' | 'integer' | 'money' | 'date' | 'boolean' | 'enum';
  required: boolean;
  description?: string;
  currency?: string;
  options?: { value: string; label: string }[];
}

export interface TemplateSectionDraft {
  heading: string;
  /** Body text, with `{{variable_key}}` where a value belongs. */
  body: string;
  order: number;
}

export interface LegalTemplateDraft {
  title: string;
  documentType: string;
  language: string;
  /** One-line statement of what this document is for. */
  purpose: string;
  sections: TemplateSectionDraft[];
  variables: TemplateVariableDraft[];
  /** Anything a lawyer must decide before this template is published. */
  reviewNotes: string[];
}

export const LEGAL_TEMPLATE_JSON_SCHEMA: JsonSchemaSpec = {
  name: 'legal_template_draft',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      documentType: { type: 'string' },
      language: { type: 'string' },
      purpose: { type: 'string' },
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
      variables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            label: { type: 'string' },
            type: {
              type: 'string',
              enum: [
                'string',
                'text',
                'number',
                'integer',
                'money',
                'date',
                'boolean',
                'enum',
              ],
            },
            required: { type: 'boolean' },
            description: { type: 'string' },
            currency: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  value: { type: 'string' },
                  label: { type: 'string' },
                },
                required: ['value', 'label'],
                additionalProperties: false,
              },
            },
          },
          // Everything listed: OpenAI strict mode requires a complete `required`
          // array and `additionalProperties: false`, and Anthropic applies the
          // same subset — so one schema serves both without branching.
          required: [
            'key',
            'label',
            'type',
            'required',
            'description',
            'currency',
            'options',
          ],
          additionalProperties: false,
        },
      },
      reviewNotes: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'title',
      'documentType',
      'language',
      'purpose',
      'sections',
      'variables',
      'reviewNotes',
    ],
    additionalProperties: false,
  },
};
