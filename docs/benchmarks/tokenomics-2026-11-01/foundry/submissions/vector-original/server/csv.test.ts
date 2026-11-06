import { test, expect } from 'bun:test';
import { parseCsv, exportCsv } from './csv';
test('RFC4180 quoted fields, escaped quotes, CRLF and embedded newlines',()=>{
  expect(parseCsv('name,email,company,notes\r\n"Doe, Ada",ada@example.invalid,"A ""studio""","First\nSecond"\r\n')).toEqual([['name','email','company','notes'],['Doe, Ada','ada@example.invalid','A "studio"','First\nSecond']]);
});
test('malformed CSV is rejected',()=>{expect(()=>parseCsv('"unclosed')).toThrow(); expect(()=>parseCsv('"x"oops')).toThrow();});
test('exports protect formulas without changing original records',()=>{const rows=[{name:' =1+1',notes:'a,"b"\nc'},{name:'\tcmd',notes:'@sum'}]; const csv=exportCsv(['name','notes'],rows); expect(parseCsv(csv)[1]).toEqual(["' =1+1",'a,"b"\nc']); expect(parseCsv(csv)[2]).toEqual(["'\tcmd","'@sum"]); expect(rows[0].name).toBe(' =1+1');});
