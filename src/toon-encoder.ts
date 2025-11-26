// TOON (Token-Oriented Object Notation) Integration
// Compresses MCP tool schemas and responses by 40-45%

export class TOONEncoder {
  /**
   * Encode data to TOON format
   * Example: {users: [{id:1, name:'Alice'}]} -> "users[1]{id,name}:\n1,Alice"
   */
  static encode(data: unknown): string {
    if (Array.isArray(data)) {
      return this.encodeArray(data);
    } else if (typeof data === 'object' && data !== null) {
      return this.encodeObject(data);
    }
    return String(data);
  }

  private static encodeObject(obj: Record<string, any>): string {
    const lines: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        lines.push(this.encodeArrayField(key, value));
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`${key}:`);
        lines.push(this.encodeObject(value).split('\n').map(l => '  ' + l).join('\n'));
      } else {
        const encoded = this.encodeScalar(value);
        lines.push(`${key}: ${encoded}`);
      }
    }

    return lines.join('\n');
  }

  private static encodeArrayField(name: string, arr: any[]): string {
    if (arr.length === 0) return `${name}[0]:`;

    // If array of objects with consistent structure
    if (arr.every(item => typeof item === 'object' && item !== null)) {
      // Flatten all objects to handle nested fields
      const flattenedArr = arr.map(item => this.flattenObject(item));
      const fields = Array.from(new Set(flattenedArr.flatMap(Object.keys)));

      const lines = [`${name}[${arr.length}]{${fields.join(',')}}:`];

      for (const item of flattenedArr) {
        const values = fields.map(f => {
          const v = item[f];
          const str = this.encodeScalar(v);
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        });
        lines.push(values.join(','));
      }

      return lines.join('\n');
    }

    // Simple array
    return `${name}[${arr.length}]: ${arr.join(',')}`;
  }

  private static flattenObject(obj: Record<string, any>, prefix = ''): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null) {
        Object.assign(result, this.flattenObject(value, newKey));
      } else {
        result[newKey] = value;
      }
    }
    return result;
  }

  private static encodeArray(arr: any[]): string {
    if (arr.length === 0) return '[]';

    if (arr.every(item => typeof item === 'object' && item !== null)) {
      const fields = Array.from(new Set(arr.flatMap(Object.keys)));
      const lines = [`[${arr.length}]{${fields.join(',')}}:`];

      for (const item of arr) {
        const values = fields.map(f => {
          const v = item[f];
          const str = this.encodeScalar(v);
          // Quote values containing comma, double-quote, or newline
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        });
        lines.push(values.join(','));
      }

      return lines.join('\n');
    }

    return arr.map(v => this.encodeScalar(v)).join(',');
  }

  /**
   * Decode TOON back to JSON
   */
  static decode(toon: string): unknown {
    const lines = toon
      .split('\n')
      .map(line => line.replace(/\r$/, ''))
      .filter(line => line.trim().length > 0);

    if (lines.length === 0) return null;

    const parsedLines = lines.map(raw => {
      const indent = raw.search(/\S|$/);
      return { indent, content: raw.trim() };
    });

    const firstContent = parsedLines[0].content;

    if (firstContent === '[]') return [];

    // Simple array of primitives (e.g., "1,2,3")
    if (!firstContent.includes(':') && parsedLines.length === 1) {
      return firstContent.split(',').map(v => this.parseValue(v));
    }

    // Top-level array without name: [N]{field1,field2}:
    const topArrayMatch = firstContent.match(/^\[(\d+)\]\{([^}]+)\}:$/);
    if (topArrayMatch) {
      const [, countStr, fieldsStr] = topArrayMatch;
      return this.parseArrayBlock(parsedLines, 0, fieldsStr.split(','), Number(countStr)).rows;
    }

    const [result] = this.parseObjectBlock(parsedLines, 0, parsedLines[0].indent);
    return result;
  }

  private static parseArrayBlock(
    lines: Array<{ indent: number; content: string }>,
    startIndex: number,
    fields: string[],
    expectedCount: number
  ): { rows: any[]; nextIndex: number } {
    const rows: any[] = [];
    let index = startIndex + 1;

    for (let i = 0; i < expectedCount && index < lines.length; i++, index++) {
      const { content } = lines[index];
      const values = this.parseCSVLine(content);
      const row: Record<string, any> = {};
      fields.forEach((field, fieldIdx) => {
        row[field] = this.parseValue(values[fieldIdx]);
      });
      rows.push(this.unflatten(row));
    }

    return { rows, nextIndex: index };
  }

  private static parseObjectBlock(
    lines: Array<{ indent: number; content: string }>,
    startIndex: number,
    currentIndent: number
  ): [Record<string, any>, number] {
    const obj: Record<string, any> = {};
    let index = startIndex;

    while (index < lines.length) {
      const { indent, content } = lines[index];
      if (indent < currentIndent) break;
      if (indent > currentIndent) {
        index++;
        continue;
      }

      const namedArrayMatch = content.match(/^(\w+)\[(\d+)\]\{([^}]+)\}:$/);
      const simpleArrayMatch = content.match(/^\[(\d+)\]\{([^}]+)\}:$/);
      const emptyArrayMatch = content.match(/^(\w+)\[0\]:$/);

      if (namedArrayMatch) {
        const [, name, countStr, fieldsStr] = namedArrayMatch;
        const { rows, nextIndex } = this.parseArrayBlock(lines, index, fieldsStr.split(','), Number(countStr));
        obj[name] = rows;
        index = nextIndex;
        continue;
      }

      if (emptyArrayMatch) {
        const [, name] = emptyArrayMatch;
        obj[name] = [];
        index++;
        continue;
      }

      if (simpleArrayMatch) {
        const [, countStr, fieldsStr] = simpleArrayMatch;
        const { rows, nextIndex } = this.parseArrayBlock(lines, index, fieldsStr.split(','), Number(countStr));
        return [rows, nextIndex];
      }

      const colonIdx = content.indexOf(':');
      if (colonIdx === -1) {
        index++;
        continue;
      }

      const key = content.substring(0, colonIdx).trim();
      const valuePart = content.substring(colonIdx + 1).trim();

      if (valuePart.length === 0) {
        const [child, nextIndex] = this.parseObjectBlock(lines, index + 1, currentIndent + 2);
        obj[key] = child;
        index = nextIndex;
      } else {
        obj[key] = this.parseValue(valuePart);
        index++;
      }
    }

    return [obj, index];
  }

  private static parseValue(value: string): any {
    if (value.startsWith("'")) return value.slice(1);
    if (value === '') return '';
    const lower = value.toLowerCase();
    if (lower === 'null') return null;
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    if (!Number.isNaN(Number(value))) return Number(value);
    return value.replace(/""/g, '"');
  }

  private static unflatten(obj: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(obj)) {
      const parts = key.split('.');
      let cursor = result;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
          cursor[part] = value;
        } else {
          if (!cursor[part] || typeof cursor[part] !== 'object') {
            cursor[part] = {};
          }
          cursor = cursor[part] as Record<string, any>;
        }
      }
    }

    return result;
  }

  private static parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  private static encodeScalar(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return '';
    if (typeof value === 'string') {
      const needsPrefix = this.isAmbiguousString(value);
      const escaped = value;
      return needsPrefix ? `'${escaped}` : escaped;
    }
    return String(value);
  }

  private static isAmbiguousString(value: string): boolean {
    if (value === '') return true;
    const trimmed = value.trim();
    const numericLike = /^[-+]?(?:\d+|\d+\.\d+|\.\d+)$/.test(trimmed);
    const leadingZeroNumber = /^0\d+/.test(trimmed);
    const booleanLike = /^(true|false)$/i.test(trimmed);
    const nullLike = trimmed.toLowerCase() === 'null';
    return numericLike || leadingZeroNumber || booleanLike || nullLike;
  }
}

interface JSONSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, {
    type?: string;
    description?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Compress MCP tool schemas using TOON
 */
export function compressToolSchema(schema: JSONSchema): string {
  // Convert JSON Schema to TOON format
  const simplified = {
    type: schema.type,
    required: schema.required || [],
    properties: Object.entries(schema.properties || {}).map(([name, prop]) => ({
      name,
      type: prop.type,
      description: prop.description?.substring(0, 50) || '',
      required: schema.required?.includes(name) ? 'yes' : 'no'
    }))
  };

  return TOONEncoder.encode(simplified);
}

/**
 * Compress tool result using TOON
 */
export function compressToolResult(result: unknown): string {
  return TOONEncoder.encode(result);
}
