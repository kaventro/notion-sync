import type { NotionBlock, NotionRichText } from "./types";

/** Max characters per Notion rich text segment */
const MAX_RICH_TEXT_LENGTH = 2000;

/** Languages accepted by the Notion API for code blocks */
const NOTION_CODE_LANGUAGES = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++",
  "c#", "css", "dart", "diff", "docker", "elixir", "elm", "erlang", "flow",
  "fortran", "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell",
  "html", "java", "javascript", "json", "julia", "kotlin", "latex", "less",
  "lisp", "livescript", "lua", "makefile", "markdown", "markup", "matlab",
  "mermaid", "nix", "objective-c", "ocaml", "pascal", "perl", "php",
  "plain text", "powershell", "prolog", "protobuf", "python", "r", "reason",
  "ruby", "rust", "sass", "scala", "scheme", "scss", "shell", "sql", "swift",
  "typescript", "vb.net", "verilog", "vhdl", "visual basic", "webassembly",
  "xml", "yaml", "java/c/c++/c#",
]);

/**
 * Converts Obsidian-flavored Markdown into Notion API block objects.
 */
export class MarkdownParser {
  /**
   * Parse a full markdown document (without frontmatter) into Notion blocks.
   */
  parse(markdown: string): NotionBlock[] {
    const lines = markdown.split("\n");
    const blocks: NotionBlock[] = [];
    let i = 0;

    while (i < lines.length) {
      const result = this.parseLine(lines, i);
      if (result.block) {
        blocks.push(result.block);
      }
      // Guard against non-advancing parsers: a sub-parser that fails to
      // consume at least one line would loop here forever and OOM.
      i = result.nextIndex > i ? result.nextIndex : i + 1;
    }

    return blocks;
  }

  /**
   * Strip YAML frontmatter from content, returning the body only.
   */
  static stripFrontmatter(content: string): string {
    if (!content.startsWith("---")) return content;
    const endIndex = content.indexOf("\n---", 3);
    if (endIndex === -1) return content;
    return content.slice(endIndex + 4).trimStart();
  }

  /**
   * Extract frontmatter as key-value pairs.
   */
  static extractFrontmatter(content: string): Record<string, unknown> {
    if (!content.startsWith("---")) return {};
    const endIndex = content.indexOf("\n---", 3);
    if (endIndex === -1) return {};

    const yaml = content.slice(4, endIndex);
    const result: Record<string, unknown> = {};

    for (const line of yaml.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      const strValue = line.slice(colonIdx + 1).trim();
      let value: unknown;

      // Parse array syntax: [item1, item2]
      if (strValue.startsWith("[") && strValue.endsWith("]")) {
        value = strValue
          .slice(1, -1)
          .split(",")
          .map((s: string) => s.trim().replace(/^['"]|['"]$/g, ""));
      }
      // Parse boolean
      else if (strValue === "true") value = true;
      else if (strValue === "false") value = false;
      // Parse number
      else if (/^\d+$/.test(strValue)) value = parseInt(strValue, 10);
      // Strip quotes
      else value = strValue.replace(/^['"]|['"]$/g, "");

      if (key) result[key] = value;
    }

    return result;
  }

  private parseLine(
    lines: string[],
    index: number
  ): { block: NotionBlock | null; nextIndex: number } {
    const line = lines[index];

    // Empty line — skip
    if (line.trim() === "") {
      return { block: null, nextIndex: index + 1 };
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      return { block: { type: "divider", divider: {} }, nextIndex: index + 1 };
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      const text = headingMatch[2];
      const type = `heading_${level}`;
      return {
        block: {
          type,
          [type]: {
            rich_text: this.parseInlineFormatting(text),
            color: "default",
            is_toggleable: false,
          },
        },
        nextIndex: index + 1,
      };
    }

    // Fenced code block — language tags may contain non-word chars
    // (e.g. "c++", "c#", "compressed-json" from Excalidraw)
    const codeMatch = line.match(/^```([^\s`]*)\s*$/);
    if (codeMatch) {
      return this.parseCodeBlock(lines, index, codeMatch[1]);
    }

    // Table
    if (this.isTableStart(lines, index)) {
      return this.parseTable(lines, index);
    }

    // Callout: > [!type] title followed by > content
    const calloutMatch = line.match(/^>\s*\[!(\w+)\]\s*(.*)?$/);
    if (calloutMatch) {
      return this.parseCallout(lines, index, calloutMatch[1], calloutMatch[2] || "");
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      return this.parseBlockquote(lines, index);
    }

    // Checklist
    const checkMatch = line.match(/^(\s*)- \[([ xX])\]\s+(.+)$/);
    if (checkMatch) {
      return this.parseChecklistItem(lines, index);
    }

    // Bullet list
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bulletMatch) {
      return this.parseBulletList(lines, index);
    }

    // Numbered list
    const numMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (numMatch) {
      return this.parseNumberedList(lines, index);
    }

    // Image (standalone line)
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgMatch) {
      return {
        block: this.makeImageBlock(imgMatch[2], imgMatch[1]),
        nextIndex: index + 1,
      };
    }

    // Obsidian embed: ![[file]]
    const embedMatch = line.match(/^!\[\[([^\]]+)\]\]\s*$/);
    if (embedMatch) {
      return {
        block: this.makeEmbedPlaceholder(embedMatch[1]),
        nextIndex: index + 1,
      };
    }

    // Paragraph (collect contiguous non-special lines)
    return this.parseParagraph(lines, index);
  }

  // ── Code Block ──────────────────────────────────────────────

  private parseCodeBlock(
    lines: string[],
    startIndex: number,
    language: string
  ): { block: NotionBlock; nextIndex: number } {
    const codeLines: string[] = [];
    let i = startIndex + 1;

    while (i < lines.length && !lines[i].match(/^```\s*$/)) {
      codeLines.push(lines[i]);
      i++;
    }

    const lang = this.mapCodeLanguage(language || "plain text");
    const content = codeLines.join("\n");

    return {
      block: {
        type: "code",
        code: {
          rich_text: this.splitLongText(content),
          caption: [],
          language: lang,
        },
      },
      nextIndex: i + 1, // skip closing ```
    };
  }

  private mapCodeLanguage(lang: string): string {
    const map: Record<string, string> = {
      // shorthands
      js: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      py: "python",
      python3: "python",
      rb: "ruby",
      sh: "shell",
      bash: "bash",
      zsh: "shell",
      fish: "shell",
      ps1: "powershell",
      yml: "yaml",
      md: "markdown",
      // C family
      "c++": "c++",
      "c#": "c#",
      cs: "c#",
      csharp: "c#",
      cpp: "c++",
      "c/c++": "c++",
      objc: "objective-c",
      "objective-c": "objective-c",
      // other
      rs: "rust",
      kt: "kotlin",
      kts: "kotlin",
      ex: "elixir",
      exs: "elixir",
      hs: "haskell",
      ml: "ocaml",
      vb: "vb.net",
      "visual basic": "visual basic",
      tf: "plain text",
      hcl: "hcl",
      dockerfile: "docker",
      proto: "protobuf",
      graphql: "graphql",
      gql: "graphql",
      "": "plain text",
    };
    const normalized = lang.toLowerCase().trim();
    const mapped = map[normalized] || normalized;
    // Notion rejects code blocks whose language is not in its fixed enum,
    // so anything unknown falls back to plain text.
    return NOTION_CODE_LANGUAGES.has(mapped) ? mapped : "plain text";
  }

  // ── Table ───────────────────────────────────────────────────

  private isTableStart(lines: string[], index: number): boolean {
    if (index + 1 >= lines.length) return false;
    const line = lines[index];
    const nextLine = lines[index + 1];
    return (
      line.includes("|") &&
      /^\|?[\s-:|]+\|?$/.test(nextLine)
    );
  }

  private parseTable(
    lines: string[],
    startIndex: number
  ): { block: NotionBlock | null; nextIndex: number } {
    const rows: string[][] = [];
    let i = startIndex;

    while (i < lines.length && lines[i].includes("|")) {
      // Skip separator row
      if (/^\|?[\s-:|]+\|?$/.test(lines[i])) {
        i++;
        continue;
      }

      const cells = lines[i]
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());

      rows.push(cells);
      i++;
    }

    if (rows.length === 0) {
      return { block: null, nextIndex: i };
    }

    const tableWidth = rows[0].length;
    const tableRows: NotionBlock[] = rows.map((row) => ({
      type: "table_row",
      table_row: {
        cells: row
          .concat(Array(Math.max(0, tableWidth - row.length)).fill(""))
          .slice(0, tableWidth)
          .map((cell) => this.parseInlineFormatting(cell)),
      },
    }));

    return {
      block: {
        type: "table",
        table: {
          table_width: tableWidth,
          has_column_header: true,
          has_row_header: false,
          children: tableRows,
        },
      },
      nextIndex: i,
    };
  }

  // ── Callout ─────────────────────────────────────────────────

  private parseCallout(
    lines: string[],
    startIndex: number,
    type: string,
    title: string
  ): { block: NotionBlock; nextIndex: number } {
    const contentLines: string[] = [];
    let i = startIndex + 1;

    while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
      contentLines.push(lines[i].replace(/^>\s?/, ""));
      i++;
    }

    const icon = this.calloutIcon(type);
    const color = this.calloutColor(type);
    const fullText = title ? `${title}\n${contentLines.join("\n")}` : contentLines.join("\n");

    return {
      block: {
        type: "callout",
        callout: {
          rich_text: this.parseInlineFormatting(fullText.trim()),
          icon: { type: "emoji", emoji: icon },
          color,
        },
      },
      nextIndex: i,
    };
  }

  private calloutIcon(type: string): string {
    const icons: Record<string, string> = {
      note: "\u{1F4DD}",
      tip: "\u{1F4A1}",
      important: "\u{2757}",
      warning: "\u{26A0}\uFE0F",
      caution: "\u{1F525}",
      info: "\u{2139}\uFE0F",
      abstract: "\u{1F4CB}",
      summary: "\u{1F4CB}",
      todo: "\u{2705}",
      success: "\u{2705}",
      question: "\u{2753}",
      help: "\u{2753}",
      failure: "\u{274C}",
      danger: "\u{26A0}\uFE0F",
      bug: "\u{1F41B}",
      example: "\u{1F4D6}",
      quote: "\u{1F4AC}",
      cite: "\u{1F4AC}",
    };
    return icons[type.toLowerCase()] || "\u{1F4DD}";
  }

  private calloutColor(type: string): string {
    const colors: Record<string, string> = {
      note: "blue_background",
      tip: "green_background",
      important: "purple_background",
      warning: "yellow_background",
      caution: "red_background",
      info: "blue_background",
      danger: "red_background",
      bug: "red_background",
      success: "green_background",
      example: "gray_background",
      quote: "gray_background",
    };
    return colors[type.toLowerCase()] || "blue_background";
  }

  // ── Blockquote ──────────────────────────────────────────────

  private parseBlockquote(
    lines: string[],
    startIndex: number
  ): { block: NotionBlock; nextIndex: number } {
    const quoteLines: string[] = [];
    let i = startIndex;

    while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
      quoteLines.push(lines[i].replace(/^>\s?/, ""));
      i++;
    }

    return {
      block: {
        type: "quote",
        quote: {
          rich_text: this.parseInlineFormatting(quoteLines.join("\n")),
          color: "default",
        },
      },
      nextIndex: i,
    };
  }

  // ── Checklist ───────────────────────────────────────────────

  private parseChecklistItem(
    lines: string[],
    startIndex: number
  ): { block: NotionBlock | null; nextIndex: number } {
    const match = lines[startIndex].match(/^(\s*)- \[([ xX])\]\s+(.+)$/);
    if (!match) return { block: null, nextIndex: startIndex + 1 };

    const indent = match[1].length;
    const checked = match[2] !== " ";
    const text = match[3];

    // Collect nested children
    const children: NotionBlock[] = [];
    let i = startIndex + 1;

    while (i < lines.length) {
      const childMatch = lines[i].match(/^(\s*)- \[([ xX])\]\s+(.+)$/);
      if (!childMatch) break;
      if (childMatch[1].length <= indent) break;

      children.push({
        type: "to_do",
        to_do: {
          rich_text: this.parseInlineFormatting(childMatch[3]),
          checked: childMatch[2] !== " ",
          color: "default",
        },
      });
      i++;
    }

    const block: NotionBlock = {
      type: "to_do",
      to_do: {
        rich_text: this.parseInlineFormatting(text),
        checked,
        color: "default",
        ...(children.length > 0 ? { children } : {}),
      },
    };

    return { block, nextIndex: i };
  }

  // ── Bullet List ─────────────────────────────────────────────

  private parseBulletList(
    lines: string[],
    startIndex: number
  ): { block: NotionBlock | null; nextIndex: number } {
    const match = lines[startIndex].match(/^(\s*)[-*+]\s+(.+)$/);
    if (!match) return { block: null, nextIndex: startIndex + 1 };

    const indent = match[1].length;
    const text = match[2];

    // Collect nested children
    const children: NotionBlock[] = [];
    let i = startIndex + 1;

    while (i < lines.length) {
      const childBullet = lines[i].match(/^(\s*)[-*+]\s+(.+)$/);
      if (!childBullet) break;
      if (childBullet[1].length <= indent) break;

      children.push({
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: this.parseInlineFormatting(childBullet[2]),
          color: "default",
        },
      });
      i++;
    }

    const block: NotionBlock = {
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: this.parseInlineFormatting(text),
        color: "default",
        ...(children.length > 0 ? { children } : {}),
      },
    };

    return { block, nextIndex: i };
  }

  // ── Numbered List ───────────────────────────────────────────

  private parseNumberedList(
    lines: string[],
    startIndex: number
  ): { block: NotionBlock | null; nextIndex: number } {
    const match = lines[startIndex].match(/^(\s*)\d+\.\s+(.+)$/);
    if (!match) return { block: null, nextIndex: startIndex + 1 };

    const indent = match[1].length;
    const text = match[2];

    const children: NotionBlock[] = [];
    let i = startIndex + 1;

    while (i < lines.length) {
      const childNum = lines[i].match(/^(\s*)\d+\.\s+(.+)$/);
      if (!childNum) break;
      if (childNum[1].length <= indent) break;

      children.push({
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: this.parseInlineFormatting(childNum[2]),
          color: "default",
        },
      });
      i++;
    }

    const block: NotionBlock = {
      type: "numbered_list_item",
      numbered_list_item: {
        rich_text: this.parseInlineFormatting(text),
        color: "default",
        ...(children.length > 0 ? { children } : {}),
      },
    };

    return { block, nextIndex: i };
  }

  // ── Paragraph ───────────────────────────────────────────────

  private parseParagraph(
    lines: string[],
    startIndex: number
  ): { block: NotionBlock; nextIndex: number } {
    const paraLines: string[] = [];
    let i = startIndex;

    while (i < lines.length) {
      const line = lines[i];
      // Stop at blank lines or block-level elements — but always consume
      // at least the first line: parseParagraph is the fallback for lines
      // no other parser claimed, so refusing the first line would return
      // nextIndex === startIndex and stall the parse loop.
      if (i > startIndex) {
        if (line.trim() === "") break;
        if (/^#{1,3}\s/.test(line)) break;
        if (/^```/.test(line)) break;
        if (/^>\s/.test(line)) break;
        if (/^[-*+]\s/.test(line)) break;
        if (/^\d+\.\s/.test(line)) break;
        if (/^- \[[ xX]\]/.test(line)) break;
        if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) break;
        if (this.isTableStart(lines, i)) break;
      }

      paraLines.push(line);
      i++;
    }

    const text = paraLines.join("\n");

    return {
      block: {
        type: "paragraph",
        paragraph: {
          rich_text: this.parseInlineFormatting(text),
          color: "default",
        },
      },
      nextIndex: i,
    };
  }

  // ── Image / Embed Blocks ────────────────────────────────────

  private makeImageBlock(url: string, caption: string): NotionBlock {
    return {
      type: "image",
      image: {
        type: "external",
        external: { url },
        caption: caption
          ? [{ type: "text", text: { content: caption } }]
          : [],
      },
    };
  }

  /** Placeholder for Obsidian embeds — stored as callout so user can see it */
  makeEmbedPlaceholder(filename: string): NotionBlock {
    return {
      type: "callout",
      callout: {
        rich_text: [
          { type: "text", text: { content: `Embedded file: ${filename}` } },
        ],
        icon: { type: "emoji", emoji: "\u{1F4CE}" },
        color: "gray_background",
      },
    };
  }

  // ── Inline Formatting Parser ────────────────────────────────

  /**
   * Parse inline markdown formatting into Notion rich_text array.
   * Handles: **bold**, *italic*, ~~strikethrough~~, `code`,
   *          [links](url), [[internal links]]
   */
  parseInlineFormatting(text: string): NotionRichText[] {
    if (!text) return [{ type: "text", text: { content: "" } }];

    const segments: NotionRichText[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      // Inline code: `text`
      const codeMatch = remaining.match(/^`([^`]+)`/);
      if (codeMatch) {
        segments.push(this.richText(codeMatch[1], { code: true }));
        remaining = remaining.slice(codeMatch[0].length);
        continue;
      }

      // Bold + italic: ***text*** or ___text___
      const boldItalicMatch = remaining.match(
        /^(\*{3}|_{3})(.+?)\1/
      );
      if (boldItalicMatch) {
        segments.push(
          this.richText(boldItalicMatch[2], { bold: true, italic: true })
        );
        remaining = remaining.slice(boldItalicMatch[0].length);
        continue;
      }

      // Bold: **text** or __text__
      const boldMatch = remaining.match(/^(\*{2}|_{2})(.+?)\1/);
      if (boldMatch) {
        segments.push(this.richText(boldMatch[2], { bold: true }));
        remaining = remaining.slice(boldMatch[0].length);
        continue;
      }

      // Italic: *text* or _text_
      const italicMatch = remaining.match(/^(\*|_)(.+?)\1/);
      if (italicMatch) {
        segments.push(this.richText(italicMatch[2], { italic: true }));
        remaining = remaining.slice(italicMatch[0].length);
        continue;
      }

      // Strikethrough: ~~text~~
      const strikeMatch = remaining.match(/^~~(.+?)~~/);
      if (strikeMatch) {
        segments.push(this.richText(strikeMatch[1], { strikethrough: true }));
        remaining = remaining.slice(strikeMatch[0].length);
        continue;
      }

      // Markdown link: [text](url)
      const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        segments.push({
          type: "text",
          text: { content: linkMatch[1], link: { url: linkMatch[2] } },
        });
        remaining = remaining.slice(linkMatch[0].length);
        continue;
      }

      // Obsidian internal link with alias: [[target|display]]
      const wikiLinkAliasMatch = remaining.match(
        /^\[\[([^\]|]+)\|([^\]]+)\]\]/
      );
      if (wikiLinkAliasMatch) {
        // Store as bold text with a marker — resolved later by linkResolver
        segments.push(
          this.richText(wikiLinkAliasMatch[2], { bold: true })
        );
        remaining = remaining.slice(wikiLinkAliasMatch[0].length);
        continue;
      }

      // Obsidian internal link: [[target]]
      const wikiLinkMatch = remaining.match(/^\[\[([^\]]+)\]\]/);
      if (wikiLinkMatch) {
        segments.push(this.richText(wikiLinkMatch[1], { bold: true }));
        remaining = remaining.slice(wikiLinkMatch[0].length);
        continue;
      }

      // Inline image: ![alt](url) — within paragraph, just add as text link
      const inlineImgMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
      if (inlineImgMatch) {
        segments.push({
          type: "text",
          text: {
            content: inlineImgMatch[1] || "image",
            link: { url: inlineImgMatch[2] },
          },
        });
        remaining = remaining.slice(inlineImgMatch[0].length);
        continue;
      }

      // Plain text: consume until next formatting marker
      const nextMarker = remaining.search(
        /[`*_~[!]|\[\[/
      );
      if (nextMarker === -1) {
        // No more markers — rest is plain text
        segments.push(this.richText(remaining));
        break;
      } else if (nextMarker === 0) {
        // Marker didn't match any pattern — consume single char
        segments.push(this.richText(remaining[0]));
        remaining = remaining.slice(1);
      } else {
        segments.push(this.richText(remaining.slice(0, nextMarker)));
        remaining = remaining.slice(nextMarker);
      }
    }

    // Merge adjacent segments with same formatting and enforce length limits
    return this.normalizeRichText(segments);
  }

  private richText(
    content: string,
    annotations?: Partial<NotionRichText["annotations"]>
  ): NotionRichText {
    const rt: NotionRichText = {
      type: "text",
      text: { content },
    };
    if (annotations && Object.values(annotations).some(Boolean)) {
      rt.annotations = {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
        ...annotations,
      };
    }
    return rt;
  }

  /** Split text longer than MAX_RICH_TEXT_LENGTH into multiple segments */
  private splitLongText(text: string): NotionRichText[] {
    const segments: NotionRichText[] = [];
    for (let i = 0; i < text.length; i += MAX_RICH_TEXT_LENGTH) {
      segments.push({
        type: "text",
        text: { content: text.slice(i, i + MAX_RICH_TEXT_LENGTH) },
      });
    }
    return segments.length > 0
      ? segments
      : [{ type: "text", text: { content: "" } }];
  }

  /** Merge adjacent plain-text segments and split any that exceed length limit */
  private normalizeRichText(segments: NotionRichText[]): NotionRichText[] {
    const result: NotionRichText[] = [];

    for (const seg of segments) {
      const content = seg.text.content;
      if (content.length <= MAX_RICH_TEXT_LENGTH) {
        result.push(seg);
      } else {
        for (let i = 0; i < content.length; i += MAX_RICH_TEXT_LENGTH) {
          result.push({
            ...seg,
            text: {
              ...seg.text,
              content: content.slice(i, i + MAX_RICH_TEXT_LENGTH),
            },
          });
        }
      }
    }

    return result.length > 0
      ? result
      : [{ type: "text", text: { content: "" } }];
  }
}
