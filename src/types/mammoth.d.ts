// Minimal ambient types for the small mammoth surface we use (raw text
// extraction from a .docx buffer). mammoth ships no type definitions.
declare module "mammoth" {
  interface ExtractResult {
    value: string;
    messages: unknown[];
  }
  interface ExtractInput {
    buffer?: Buffer;
    arrayBuffer?: ArrayBuffer;
    path?: string;
  }
  export function extractRawText(input: ExtractInput): Promise<ExtractResult>;
  const _default: { extractRawText: typeof extractRawText };
  export default _default;
}
