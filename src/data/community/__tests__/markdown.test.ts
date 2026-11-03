import { describe, expect, it } from "vitest";
import { plainText, renderInline, renderMarkdown } from "../markdown";

describe("community markdown", () => {
  it("escapes HTML", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).toBe("<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
    expect(renderInline("<script>")).toBe("&lt;script&gt;");
  });

  it("renders emphasis and code", () => {
    expect(renderInline("**bold** *it* _it_ ~~gone~~ `a*b*c`")).toBe("<strong>bold</strong> <em>it</em> <em>it</em> <del>gone</del> <code>a*b*c</code>");
    expect(renderInline("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4");
  });

  it("links only http(s) addresses", () => {
    expect(renderInline("[site](https://example.com/a?b=1&c=2)")).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2" data-external="1" rel="noopener noreferrer">site</a>',
    );
    expect(renderInline("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
    expect(renderInline("see https://example.com/x.")).toBe(
      'see <a href="https://example.com/x" data-external="1" rel="noopener noreferrer">https://example.com/x</a>.',
    );
    expect(renderInline('[a](https://x.com/"onmouseover="y)')).not.toContain('"onmouseover');
  });

  it("renders blocks", () => {
    expect(renderMarkdown("# Title\n\nline one\nline two\n\n- a\n- b\n\n1. x\n2. y")).toBe(
      "<h3>Title</h3><p>line one<br>line two</p><ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol>",
    );
    expect(renderMarkdown("> quoted\n> more\n\n---\n\n```\n<b>code</b>\n```")).toBe(
      "<blockquote><p>quoted<br>more</p></blockquote><hr><pre><code>&lt;b&gt;code&lt;/b&gt;</code></pre>",
    );
  });

  it("renders tables", () => {
    expect(renderMarkdown("| A | B |\n|---|:-:|\n| 1 | 2 |\n| 3 |")).toBe(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td></td></tr></tbody></table>",
    );
  });

  it("starts a list right after a paragraph line", () => {
    expect(renderMarkdown("Pros:\n- cheap\n- fast")).toBe("<p>Pros:</p><ul><li>cheap</li><li>fast</li></ul>");
  });

  it("strips marks for previews", () => {
    expect(plainText("# Title\n\n**Source:** [site](https://x.com)\n- *one*\n- `two`")).toBe("Title Source: site one two");
  });
});
