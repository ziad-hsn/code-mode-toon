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
        lines.push(`${key}: ${value}`);
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
          if (v === undefined || v === null) return '';
          const str = String(v);
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
        const values = fields.map(f => String(item[f] ?? ''));
        lines.push(values.join(','));
      }

      return lines.join('\n');
    }

    return arr.join(',');
  }

  /**
   * Decode TOON back to JSON
   */
  static decode(toon: string): unknown {
    const lines = toon.split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length === 0) return null;

    const firstLine = lines[0];

    // Array format: name[N]{field1,field2}:
    const arrayMatch = firstLine.match(/^(\w+)\[(\d+)\]\{([^}]+)\}:$/);
    if (arrayMatch) {
      const [, name, count, fieldsStr] = arrayMatch;
      const fields = fieldsStr.split(',');
      const rows = lines.slice(1).map(line => {
        const values = this.parseCSVLine(line);
        const obj: Record<string, unknown> = {};
        fields.forEach((f, i) => {
          obj[f] = values[i] || null;
        });
        return obj;
      });
      return { [name]: rows };
    }

    // Simple object
    const result: Record<string, unknown> = {};
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      result[key] = value;
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
