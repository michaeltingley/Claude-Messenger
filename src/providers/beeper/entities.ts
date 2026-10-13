/**
 * A character reference in Matrix's HTML: decimal, hex, or one of the names
 * messages use. Kept to this module and used only by `replace` and
 * `matchAll`, so no caller can leave it part-way through a text.
 */
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi;

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['ldquo', '“'],
  ['rdquo', '”'],
]);

/**
 * What an `ENTITY` match stands for, from its groups: the character, or the
 * entity as written when it names none. Never longer than the entity.
 */
function decoded(entity: string, decimal?: string, hex?: string, name?: string): string {
  if (name !== undefined) return NAMED_ENTITIES.get(name.toLowerCase()) ?? entity;
  const codePoint = decimal !== undefined ? Number(decimal) : parseInt(hex!, 16);
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
}

/** An entity in a text: where it is, and what it stands for. */
export interface Entity {
  readonly index: number;
  readonly length: number;
  /** What it stands for, never longer than the entity. */
  readonly decoded: string;
}

/** Each entity in `html`, in order. */
export function entitiesIn(html: string): Entity[] {
  return Array.from(html.matchAll(ENTITY), (match) => ({
    index: match.index,
    length: match[0].length,
    decoded: decoded(match[0], match[1], match[2], match[3]),
  }));
}

/** `html` with each entity decoded once, so "&amp;lt;" becomes "&lt;". */
export function decodeEntities(html: string): string {
  return html.replace(ENTITY, decoded);
}
