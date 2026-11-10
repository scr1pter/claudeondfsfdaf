import { test, expect } from 'bun:test';
import { parseCsv, csvCell, integer, date } from './validation';

test('CSV handles escaped quotes, CRLF and embedded newlines', () => {
  expect(parseCsv('name,email,company,notes\r\n"Vale, Ada",ada@example.invalid,"A ""Quoted"" Co","line one\nline two"\r\n')).toEqual([['name', 'email', 'company', 'notes'], ['Vale, Ada', 'ada@example.invalid', 'A "Quoted" Co', 'line one\nline two']]);
  expect(() => parseCsv('"unclosed')).toThrow();
  expect(() => parseCsv('"value"trailing')).toThrow();
});
test('CSV formula neutralization is applied to strings and preserves delimiters', () => {
  expect(csvCell('  =1+1')).toBe("'  =1+1"); expect(csvCell('\tformula')).toBe("'\tformula"); expect(csvCell(-8)).toBe('-8'); expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
});
test('quantities and dates reject coercion, fractions, impossible dates', () => {
  for (const v of ['1', 1.5, null, Infinity]) expect(() => integer(v, 'Quantity', 1, 10)).toThrow();
  for (const v of ['2026-02-30', '2025-02-29', '2026-13-01', 'no', 7]) expect(() => date(v)).toThrow();
  expect(date('2028-02-29')).toBe('2028-02-29'); expect(date(null)).toBeNull();
});
