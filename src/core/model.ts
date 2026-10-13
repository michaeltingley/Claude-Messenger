/**
 * The provider-agnostic port for a language model that writes text.
 *
 * Text in, text out, and nothing else: the model gets no tools. Whatever
 * writes from the owner's messages reads text anyone can send the owner, so
 * the one thing a message can make it do is write. What it writes is still
 * only data to whoever shows it on.
 *
 * Implementations live under `providers/`. The composition root picks one,
 * and everything above it (the digest, and whatever drafts later) programs
 * against this.
 */
export interface LanguageModel {
  /**
   * Write what `instructions` ask for, from `input`. Resolves with the text,
   * trimmed; rejects with `ModelError` when no answer came back.
   */
  write(request: WriteRequest): Promise<string>;
}

export interface WriteRequest {
  /** What to write and how. Fixed text, never message content. */
  instructions: string;
  /**
   * The material to write from, which may hold message content.
   * Implementations keep it off command lines, out of logs and off disk.
   */
  input: string;
}
