import { describe, expect, it } from "bun:test";
import { SLUG_RE, slugify } from "../../src/server/core/slugify";

describe("slugify", () => {
  it("matches the spec examples", () => {
    expect(slugify("Bitcoin Node")).toBe("bitcoin-node");
    expect(slugify("AEM 6.5 LTS!")).toBe("aem-6-5-lts");
  });

  it("strips accents", () => {
    expect(slugify("Perché")).toBe("perche");
    expect(slugify("Viaje a España")).toBe("viaje-a-espana");
    expect(slugify("àèìòù ÁÉÍÓÚ äöü ñ ç")).toBe("aeiou-aeiou-aou-n-c");
  });

  it("collapses symbols and consecutive separators to a single dash", () => {
    expect(slugify("foo   bar")).toBe("foo-bar");
    expect(slugify("foo---bar")).toBe("foo-bar");
    expect(slugify("foo & bar / baz")).toBe("foo-bar-baz");
  });

  it("strips leading and trailing dashes", () => {
    expect(slugify("  hello  ")).toBe("hello");
    expect(slugify("!wow!")).toBe("wow");
  });

  it("maps casing/accent/symbol variants to the same slug", () => {
    for (const variant of ["Bitcoin Node", "bitcoin node", "BITCOIN-NODE", "Bitcóin Nodé"]) {
      expect(slugify(variant)).toBe("bitcoin-node");
    }
  });

  it("throws a clear error when the slug would be empty", () => {
    expect(() => slugify("!!!")).toThrow(/empty slug/);
    expect(() => slugify("   ")).toThrow(/empty slug/);
  });

  it("always produces slugs matching the server-side validation regex", () => {
    for (const title of ["Bitcoin Node", "AEM 6.5 LTS!", "Perché", "a", "42"]) {
      expect(slugify(title)).toMatch(SLUG_RE);
    }
  });
});
