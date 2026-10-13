/** A character reference in Matrix's HTML: decimal, hex, or one of the names messages use. */
export const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi;

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
export function decodeEntity(entity: string, decimal?: string, hex?: string, name?: string): string {
  if (name !== undefined) return NAMED_ENTITIES.get(name.toLowerCase()) ?? entity;
  const codePoint = decimal !== undefined ? Number(decimal) : parseInt(hex!, 16);
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
}
