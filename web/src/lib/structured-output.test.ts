import { describe, expect, test } from "bun:test";
import {
  parseResponseFormat,
  type ResponseFormat,
  schemaText,
  validateResponseFormat,
} from "./structured-output.ts";

const validSchema = { type: "object", properties: { a: { type: "string" } } };
// Annotated so `type` stays the literal "json_schema" instead of widening to
// string, which would not satisfy ResponseFormat in the equality assertions.
const validEnvelope: ResponseFormat = {
  type: "json_schema",
  json_schema: { schema: validSchema },
};

describe("validateResponseFormat", () => {
  test("accepts the envelope the listener accepts", () => {
    expect(validateResponseFormat(validEnvelope)).toBeNull();
  });

  test("rejects a non-object", () => {
    expect(validateResponseFormat(null)).toBeString();
    expect(validateResponseFormat("schema")).toBeString();
    expect(validateResponseFormat([])).toBeString();
    expect(validateResponseFormat(42)).toBeString();
  });

  test("rejects the wrong type field", () => {
    expect(validateResponseFormat({ type: "json_object" })).toBeString();
    expect(validateResponseFormat({ json_schema: { schema: validSchema } })).toBeString();
  });

  test("rejects a missing or malformed json_schema wrapper", () => {
    expect(validateResponseFormat({ type: "json_schema" })).toBeString();
    expect(validateResponseFormat({ type: "json_schema", json_schema: "x" })).toBeString();
    expect(validateResponseFormat({ type: "json_schema", json_schema: [] })).toBeString();
  });

  test("rejects a missing or malformed inner schema", () => {
    expect(validateResponseFormat({ type: "json_schema", json_schema: {} })).toBeString();
    expect(
      validateResponseFormat({ type: "json_schema", json_schema: { schema: "no" } }),
    ).toBeString();
  });
});

describe("parseResponseFormat", () => {
  test("empty input is neither a value nor an error", () => {
    expect(parseResponseFormat("")).toEqual({ value: null, error: null });
    expect(parseResponseFormat("   ")).toEqual({ value: null, error: null });
  });

  test("a bare JSON Schema is wrapped into the envelope", () => {
    const { value, error } = parseResponseFormat(JSON.stringify(validSchema));
    expect(error).toBeNull();
    expect(value).toEqual(validEnvelope);
  });

  test("a full envelope is passed through unchanged", () => {
    const { value, error } = parseResponseFormat(JSON.stringify(validEnvelope));
    expect(error).toBeNull();
    expect(value).toEqual(validEnvelope);
  });

  test("invalid JSON reports the parse failure", () => {
    const { value, error } = parseResponseFormat("{not json");
    expect(value).toBeNull();
    expect(error).toContain("Invalid JSON");
  });

  test("JSON that parses but cannot be a schema is rejected", () => {
    expect(parseResponseFormat('"just a string"').value).toBeNull();
    expect(parseResponseFormat("[1,2]").error).toBeString();
    expect(parseResponseFormat("null").value).toBeNull();
  });

  test('a bare `{"type":"object"}` is a valid schema and gets wrapped', () => {
    // Not a mistake: that is a real (permissive) JSON Schema, and the envelope
    // detection keys on `json_schema`, so it wraps rather than erroring.
    const { value, error } = parseResponseFormat('{"type":"object"}');
    expect(error).toBeNull();
    expect(value).toEqual({ type: "json_schema", json_schema: { schema: { type: "object" } } });
  });
});

describe("schemaText", () => {
  test("renders the bare schema, not the envelope", () => {
    expect(schemaText(validEnvelope)).toBe(JSON.stringify(validSchema, null, 2));
  });

  test("null renders empty", () => {
    expect(schemaText(null)).toBe("");
  });
});
