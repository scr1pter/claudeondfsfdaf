import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

test("the preserved v1 schema retains a completed legacy job", () => {
  const database = new Database(":memory:");
  database.exec(
    readFileSync(new URL("../sql/v1.sql", import.meta.url), "utf8"),
  );
  database
    .query(
      "INSERT INTO jobs(id,name,kind,status,attempt,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      "legacy",
      "Legacy completed",
      "succeed",
      "succeeded",
      1,
      "legacy result",
      1,
      1,
    );
  database.exec(
    readFileSync(new URL("../sql/v1.sql", import.meta.url), "utf8"),
  );
  expect(
    database
      .query<
        { result: string },
        []
      >("SELECT result FROM jobs WHERE id='legacy'")
      .get()?.result,
  ).toBe("legacy result");
  database.close();
});
