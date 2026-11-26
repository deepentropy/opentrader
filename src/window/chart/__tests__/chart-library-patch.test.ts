import { describe, expect, it } from "vitest";
import production from "../../../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs?raw";
import development from "../../../../node_modules/lightweight-charts/dist/lightweight-charts.development.mjs?raw";

// scripts/patch-chart-library.mjs (postinstall): ending a price-axis drag that never started leaves a chart drag's
// price-range snapshot alone (else every later chart drag throws "Value is null").
describe("chart library fix", () => {
  it("is in the release build", () => {
    expect(production).toContain("c_(){this.qe()||this.Oo()||null===this.Co||(this.Co=null,this._o=null)}");
  });

  it("is in the development build", () => {
    expect(development).toMatch(/_internal_endScale\(\) \{[^}]*\}\s*if \(this\._private__scaleStartPoint === null\) \{\s*return;/);
  });
});
