/**
 * Digits a number could be written with, and what can group them: any run
 * of spaces, or up to three signs that aren't a letter, a digit or a space
 * (dots, dashes, slashes, brackets, dots in the middle), between two digits.
 * A letter or a line break ends a number, and so do a comma or a semicolon
 * and a space, as they end an item of a list. A digit's marks go with it, as
 * a keycap's do ("4️⃣"), and so does a "+", "(" or currency sign right before
 * the first digit. A run of spaces is one group, matched whole, and each
 * number is matched from its start, so this takes time linear in the text.
 */
const DIGITS =
  /(?:[+(\p{Sc}][^\S\n]?)?\p{N}\p{M}*(?:(?:[^\S\n]+(?![^\S\n])|(?:[,;](?![^\S\n])|[^\p{L}\p{N}\p{M}\s,;])\p{M}*){0,3}\p{N}\p{M}*)*/gu;

/** The most digits a number may show: fewer than a code, a phone number or an account number has. */
const MAX_DIGITS_SHOWN = 5;

const MONTH = String.raw`(?:0?[1-9]|1[0-2])`;
const DAY = String.raw`(?:0?[1-9]|[12]\d|3[01])`;
const YEAR = String.raw`(?:19|20)\d{2}`;
/** 2026-10-13, 10/13, 13.10.2026, 10-13-26. */
const DATE = String.raw`(?:${YEAR}-${MONTH}-${DAY}|(?:${MONTH}[/.-]${DAY}|${DAY}[/.-]${MONTH})(?:[/.-](?:\d{4}|\d{2}))?)`;
/** 7:46, 19:30:05, 7.30. */
const TIME = String.raw`(?:[01]?\d|2[0-3])[:.][0-5]\d(?::[0-5]\d)?`;
/**
 * $1,250.00, €1.250,00, $12.50: always with its currency sign, so that a
 * code can't pass for one ("123,456"), and at most five digits without
 * groups of thousands, so that a phone number can't either ("$4155550199").
 */
const AMOUNT = String.raw`(?:\p{Sc}\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\p{Sc}\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\p{Sc}\d{1,5}(?:[.,]\d{1,2})?)`;
const ITEM = String.raw`(?:${DATE}|${TIME}|${AMOUNT})`;

/**
 * A number made only of dates, times and amounts, its spaces each one
 * space: one, or up to four one after another or in spans ("10/13/2026
 * 7:46", "7:30 - 9:00", "10/13 7:30 – 10/14 9:00"), or a span of years
 * ("2026–2027"). Some read more than one way ("10.10" is a date or a
 * time), and every way is tried before a number is found to be none, so
 * there are at most four: on any number, that takes a few hundred tries at
 * most.
 */
const DATES_TIMES_AND_AMOUNTS = new RegExp(
  String.raw`^(?:${ITEM}(?:(?:,| ?[-\u2013\u2014] ?| )${ITEM}){0,3}|${YEAR} ?[-\u2013\u2014] ?(?:${YEAR}|\d{2}))$`,
  'u',
);

/** More digits than a number may show, wherever they are in it. */
const TOO_MANY_DIGITS = new RegExp(String.raw`\p{N}(?:\P{N}*\p{N}){${MAX_DIGITS_SHOWN}}`, 'u');

/**
 * `text` with each number that could be a phone number, a code or an
 * account number written "(number)": any of more than five digits, however
 * they are grouped, but for one made only of dates, times and amounts.
 */
export function withoutNumbers(text: string): string {
  return text.replace(DIGITS, (number) =>
    TOO_MANY_DIGITS.test(number) && !onlyDatesTimesAndAmounts(number) ? '(number)' : number,
  );
}

function onlyDatesTimesAndAmounts(number: string): boolean {
  return DATES_TIMES_AND_AMOUNTS.test(number.replace(/^\(/, '').replace(/[^\S\n]+/g, ' '));
}
