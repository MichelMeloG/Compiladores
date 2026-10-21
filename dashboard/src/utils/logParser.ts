/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventSeverity, EventType, LogEvent, RoverState } from '../types';

export interface ParseResult {
  validEvents: LogEvent[];
  errors: Array<{ line: number; message: string; raw: string }>;
  warnings: string[];
  totalParsed: number;
}

// Aliases mapping dictionaries
const TIMESTAMP_ALIASES = [
  'timestamp',
  'time',
  'datetime',
  'event_time',
  'eventtime',
  'date',
  'data_hora',
  'datahora',
  'horario',
  'data',
  'ts',
];

const MISSION_ID_ALIASES = [
  'missionid',
  'mission_id',
  'id_missao',
  'missao',
  'missaoid',
  'mission',
  'trip_id',
  'tripid',
  'run_id',
  'runid',
  'execucao_id',
  'execucao',
];

const EVENT_TYPE_ALIASES = [
  'eventtype',
  'event_type',
  'tipo_evento',
  'tipoevento',
  'tipo',
  'type',
  'event',
  'evento',
  'action',
  'acao',
  'category',
];

const COMMAND_ALIASES = [
  'command',
  'comando',
  'cmd',
  'instruction',
  'instrucao',
  'ordem',
];

const ROVER_STATE_ALIASES = [
  'roverstate',
  'rover_state',
  'estado',
  'state',
  'status_carrinho',
  'status',
];

const SEVERITY_ALIASES = [
  'severity',
  'severidade',
  'level',
  'nivel',
  'grau',
  'log_level',
];

const MESSAGE_ALIASES = [
  'message',
  'mensagem',
  'msg',
  'description',
  'descricao',
  'detail',
  'detalhe',
  'info',
];

/**
 * Searches an object with case-insensitive and underscore-insensitive matching
 */
function findFieldValue(record: Record<string, unknown>, aliases: string[]): unknown {
  const keys = Object.keys(record);
  for (const alias of aliases) {
    const cleanAlias = alias.toLowerCase().replace(/[-_]/g, '');
    for (const key of keys) {
      const cleanKey = key.toLowerCase().replace(/[-_]/g, '');
      if (cleanKey === cleanAlias) {
        return record[key];
      }
    }
  }
  return undefined;
}

/**
 * Maps arbitrary event type or message to canonical EventType
 */
export function normalizeEventType(rawType?: unknown, rawMessage?: unknown): EventType {
  const str = String(rawType || '').toLowerCase().trim();
  const msg = String(rawMessage || '').toLowerCase().trim();

  if (str === 'mission_start' || str === 'inicio_missao' || str === 'start' || msg.includes('início da missão') || msg.includes('missao iniciada')) {
    return 'mission_start';
  }
  if (str === 'destination_reached' || str === 'destino_alcancado' || str === 'chegada' || msg.includes('destino alcançado') || msg.includes('chegou ao destino')) {
    return 'destination_reached';
  }
  if (str === 'mission_end' || str === 'fim_missao' || str === 'concluida' || msg.includes('missão concluída') || msg.includes('missao finalizada')) {
    return 'mission_end';
  }
  if (str === 'presence_detected' || str === 'presenca_detectada' || str === 'obstaculo' || msg.includes('presença detectada') || msg.includes('sensor detectou')) {
    return 'presence_detected';
  }
  if (str === 'stop_preventive' || str === 'parada_preventiva' || str === 'parada' || msg.includes('parada preventiva') || msg.includes('carrinho parou')) {
    return 'stop_preventive';
  }
  if (str === 'resume' || str === 'retomada' || msg.includes('retomada') || msg.includes('retomando movimento')) {
    return 'resume';
  }
  if (str === 'command' || str === 'comando' || str === 'cmd') {
    return 'command';
  }
  if (str === 'state_change' || str === 'mudanca_estado') {
    return 'state_change';
  }
  if (str === 'error' || str === 'erro' || str === 'falha' || msg.includes('erro') || msg.includes('falha')) {
    return 'error';
  }
  if (str === 'warning' || str === 'aviso' || str === 'alerta' || msg.includes('alerta') || msg.includes('aviso')) {
    return 'warning';
  }

  // Fallback inferred from message
  if (msg.includes('parada')) return 'stop_preventive';
  if (msg.includes('presenca') || msg.includes('presença')) return 'presence_detected';
  return 'unknown';
}

/**
 * Maps arbitrary severity to canonical EventSeverity
 */
export function normalizeSeverity(rawSeverity?: unknown, eventType?: EventType): EventSeverity {
  const str = String(rawSeverity || '').toLowerCase().trim();
  if (str === 'critical' || str === 'critico' || str === 'fatal') return 'critical';
  if (str === 'error' || str === 'erro' || str === 'err') return 'error';
  if (str === 'warning' || str === 'aviso' || str === 'warn' || str === 'alerta') return 'warning';
  if (str === 'info' || str === 'informacao' || str === 'informativo') return 'info';

  if (eventType === 'error') return 'error';
  if (eventType === 'warning' || eventType === 'presence_detected') return 'warning';
  return 'info';
}

/**
 * Validates and normalizes timestamp to ISO string
 */
export function normalizeTimestamp(rawTime?: unknown): string | null {
  if (!rawTime) return null;
  const str = String(rawTime).trim();
  
  // Try ISO parse
  let d = new Date(str);
  if (!isNaN(d.getTime())) {
    return d.toISOString();
  }

  // Try numeric unix timestamp (seconds or ms)
  const num = Number(str);
  if (!isNaN(num) && num > 0) {
    // If < 10000000000, probably in seconds
    const ms = num < 10000000000 ? num * 1000 : num;
    d = new Date(ms);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }

  // Try parsing DD/MM/YYYY HH:mm:ss format commonly used in Brazil
  const ddmmyyyyMatch = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (ddmmyyyyMatch) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = ddmmyyyyMatch;
    d = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }

  return null;
}

/**
 * Normalizes a single raw record into LogEvent
 */
export function normalizeRawRecord(record: Record<string, unknown>, index: number): { event?: LogEvent; error?: string } {
  const rawTimestamp = findFieldValue(record, TIMESTAMP_ALIASES);
  const normalizedTime = normalizeTimestamp(rawTimestamp);
  if (!normalizedTime) {
    return {
      error: `Timestamp ausente ou inválido (${String(rawTimestamp || 'vazio')})`,
    };
  }

  const rawMissionId = findFieldValue(record, MISSION_ID_ALIASES);
  const missionId = rawMissionId ? String(rawMissionId).trim() : 'unassigned';

  const rawMessage = findFieldValue(record, MESSAGE_ALIASES);
  const message = rawMessage ? String(rawMessage).trim() : 'Sem mensagem descritiva';

  const rawEventType = findFieldValue(record, EVENT_TYPE_ALIASES);
  const eventType = normalizeEventType(rawEventType, message);

  const rawSeverity = findFieldValue(record, SEVERITY_ALIASES);
  const severity = normalizeSeverity(rawSeverity, eventType);

  const rawCommand = findFieldValue(record, COMMAND_ALIASES);
  const command = rawCommand ? String(rawCommand).trim() : undefined;

  const rawState = findFieldValue(record, ROVER_STATE_ALIASES);
  const roverState = (rawState ? String(rawState).toLowerCase().trim() : undefined) as RoverState | undefined;

  const id = String(record.id || `evt-${missionId}-${index}-${Date.now()}`);

  return {
    event: {
      id,
      missionId,
      timestamp: normalizedTime,
      eventType,
      command,
      roverState,
      severity,
      message,
      payload: record,
      raw: JSON.stringify(record),
    },
  };
}

/**
 * Parses JSON content (either single object, array of objects, or JSON lines)
 */
export function parseJsonLogs(content: string): ParseResult {
  const result: ParseResult = {
    validEvents: [],
    errors: [],
    warnings: [],
    totalParsed: 0,
  };

  const trimmed = content.trim();
  if (!trimmed) {
    result.errors.push({ line: 1, message: 'Arquivo JSON vazio.', raw: '' });
    return result;
  }

  let parsedData: unknown;
  try {
    parsedData = JSON.parse(trimmed);
  } catch (initialErr) {
    // Attempt parsing as JSON Lines (one JSON object per line)
    const lines = trimmed.split('\n');
    let anySuccess = false;

    lines.forEach((line, idx) => {
      const lineTrim = line.trim();
      if (!lineTrim) return;
      result.totalParsed++;
      try {
        const item = JSON.parse(lineTrim);
        if (typeof item === 'object' && item !== null) {
          const { event, error } = normalizeRawRecord(item as Record<string, unknown>, idx + 1);
          if (event) {
            result.validEvents.push(event);
            anySuccess = true;
          } else {
            result.errors.push({ line: idx + 1, message: error || 'Erro de validação', raw: lineTrim });
          }
        }
      } catch {
        result.errors.push({
          line: idx + 1,
          message: 'Linha com JSON inválido.',
          raw: lineTrim.slice(0, 100),
        });
      }
    });

    if (!anySuccess) {
      result.errors.push({
        line: 1,
        message: `Falha ao processar JSON: ${initialErr instanceof Error ? initialErr.message : 'Sintaxe inválida'}`,
        raw: trimmed.slice(0, 100),
      });
    }
    return result;
  }

  // Handled JSON array or single object
  const items = Array.isArray(parsedData) ? parsedData : [parsedData];
  result.totalParsed = items.length;

  items.forEach((item, idx) => {
    if (typeof item !== 'object' || item === null) {
      result.errors.push({
        line: idx + 1,
        message: 'Registro não é um objeto JSON válido.',
        raw: String(item),
      });
      return;
    }
    const { event, error } = normalizeRawRecord(item as Record<string, unknown>, idx + 1);
    if (event) {
      result.validEvents.push(event);
    } else {
      result.errors.push({
        line: idx + 1,
        message: error || 'Validação falhou',
        raw: JSON.stringify(item).slice(0, 100),
      });
    }
  });

  return result;
}

/**
 * Parses CSV content with automatic delimiter detection (comma, semicolon, tab)
 */
export function parseCsvLogs(content: string): ParseResult {
  const result: ParseResult = {
    validEvents: [],
    errors: [],
    warnings: [],
    totalParsed: 0,
  };

  const clean = content.trim();
  if (!clean) {
    result.errors.push({ line: 1, message: 'Arquivo CSV vazio.', raw: '' });
    return result;
  }

  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    result.errors.push({
      line: 1,
      message: 'O CSV deve conter ao menos uma linha de cabeçalho e uma de dados.',
      raw: clean.slice(0, 80),
    });
    return result;
  }

  // Detect delimiter based on first line
  const headerLine = lines[0];
  const commaCount = (headerLine.match(/,/g) || []).length;
  const semiCount = (headerLine.match(/;/g) || []).length;
  const tabCount = (headerLine.match(/\t/g) || []).length;

  let delimiter = ',';
  if (semiCount > commaCount && semiCount >= tabCount) {
    delimiter = ';';
  } else if (tabCount > commaCount && tabCount > semiCount) {
    delimiter = '\t';
  }

  // Split line with CSV quote awareness
  const splitCsvLine = (line: string): string[] => {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' || char === "'") {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        values.push(current.trim().replace(/^["']|["']$/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim().replace(/^["']|["']$/g, ''));
    return values;
  };

  const headers = splitCsvLine(headerLine).map((h) => h.toLowerCase().trim());
  result.totalParsed = lines.length - 1;

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    const values = splitCsvLine(rawLine);
    const record: Record<string, unknown> = {};

    headers.forEach((header, colIdx) => {
      record[header] = values[colIdx] ?? '';
    });

    const { event, error } = normalizeRawRecord(record, i + 1);
    if (event) {
      result.validEvents.push(event);
    } else {
      result.errors.push({
        line: i + 1,
        message: error || 'Erro de validação CSV',
        raw: rawLine.slice(0, 100),
      });
    }
  }

  return result;
}
