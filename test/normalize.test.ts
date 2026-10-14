import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { typescriptToSchema } from "../src/normalize";

describe("typescriptToSchema", () => {
  it("converts interfaces, optional/nullable fields, enums and refs", () => {
    const { definitions } = typescriptToSchema(
      `export interface Order { id: string; status: "open" | "paid"; note?: string | null; items: Item[]; meta: Record<string, number> }
       export interface Item { sku: string; qty: number }`,
    );
    const order = definitions.Order as any;
    expect(order.required.sort()).toEqual(["id", "items", "meta", "status"]);
    expect(order.properties.status.enum).toEqual(["open", "paid"]);
    expect(order.properties.note.type).toEqual(["null", "string"]);
    expect(order.properties.items.items).toEqual({ $ref: "#/definitions/Item" });
    expect(order.properties.meta).toEqual({ type: "object" });
    expect(order.properties.id.title).toBeUndefined();
    expect(Object.keys(definitions).sort()).toEqual(["Item", "Order"]);
  });

  it("reports syntax errors without leaking temp paths", () => {
    expect(() => typescriptToSchema("export interface Broken { id: string")).toThrowError(/the snippet|TypeScript/);
  });
});

describe("server", () => {
  it("requires the shared secret", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "POST", url: "/normalize", payload: { language: "typescript", source: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("normalizes over HTTP", async () => {
    const app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/normalize",
      headers: { "x-worker-secret": "dev-typeworker-secret" },
      payload: { language: "typescript", source: "export interface A { x: number }" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().definitions.A.properties.x.type).toBe("number");
  });
});

describe("codegen and mock", () => {
  const definitions = {
    Order: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        status: { type: "string", enum: ["open", "paid"] },
        items: { type: "array", items: { $ref: "#/definitions/Item" } },
      },
      required: ["id", "status", "items"],
    },
    Item: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
  };

  it("generates typescript, zod and pydantic named after the definitions", async () => {
    const { generateTypes } = await import("../src/codegen");
    const ts = await generateTypes(definitions, "typescript");
    expect(ts).toContain("export interface Order");
    expect(ts).toMatch(/items:\s+Item\[\]/);
    expect(ts).not.toContain("[property: string]");
    const zod = await generateTypes(definitions, "zod");
    const py = await generateTypes(definitions, "pydantic");
    expect(zod).toContain("OrderSchema = z.object");
    expect(py).toContain("class Order(BaseModel)");
    for (const code of [ts, zod, py]) {
      expect(code).not.toContain("AgentSyncRoot");
      expect(code).not.toContain("ItemElement");
    }
  });

  it("mocks schema-valid data deterministically with a seed", async () => {
    const { mockData } = await import("../src/codegen");
    const a = mockData({ $ref: "#/definitions/Order" }, definitions, 42) as any;
    const b = mockData({ $ref: "#/definitions/Order" }, definitions, 42);
    expect(a).toEqual(b);
    expect(["open", "paid"]).toContain(a.status);
    expect(typeof a.items[0].sku).toBe("string");
  });
});
