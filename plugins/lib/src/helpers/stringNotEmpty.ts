/**
 * Whether a string says anything.
 *
 * A manifest field written as `""` is a field that was left blank, and a field of spaces is the same thing. Named for the
 * question it answers, so a caller reads `stringNotEmpty(value) ? value : fallback` instead of a truthiness test that
 * quietly accepts whitespace.
 */
export const stringNotEmpty = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";
