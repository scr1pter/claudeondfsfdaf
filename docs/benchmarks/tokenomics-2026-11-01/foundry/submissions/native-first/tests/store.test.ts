import { test, expect } from "bun:test";
import { parseCSV, csvCell, integer, text, choice } from "../server/store";

test("CSV parser preserves quoted commas, escaped quotes and CRLF inside fields", () => {
  expect(parseCSV('name,email,company,notes\r\n"River, Co",river@example.invalid,"The ""River""","Line 1\r\nLine 2"\r\n')).toEqual([
    ["name", "email", "company", "notes"], ["River, Co", "river@example.invalid", 'The "River"', "Line 1\r\nLine 2"],
  ]);
  for (const bad of ['"unfinished', 'a"b,c', '"a"bad,b']) expect(() => parseCSV(bad)).toThrow();
});
test("CSV export escapes formulas without modifying source values", () => {
  for (const s of ["=SUM(A1)", "  +formula", "-formula", "@formula", "\ttab", "\rcarriage"]) expect(csvCell(s).startsWith("'") || csvCell(s).startsWith('"\'')).toBe(true);
  expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  expect(csvCell(-3)).toBe("-3");
  expect(csvCell(null)).toBe("");
});
test("strict validation rejects coercion and whitespace-only values", () => {
  for (const v of ["1", 1.1, NaN, Infinity, null, true]) expect(() => integer(v, "Quantity", 0, 5)).toThrow();
  expect(integer(5, "Quantity", 0, 5)).toBe(5);
  expect(() => text(" \n", "Name", true)).toThrow();
  expect(text("  original\n", "Notes")).toBe("  original\n");
  expect(() => choice("unknown", "Status", ["todo"])).toThrow();
});
