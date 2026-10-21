/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import {
  UploadCloud,
  FileCode,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  Download,
  Eye,
  Check,
  X,
  ArrowRight,
} from 'lucide-react';
import { parseJsonLogs, parseCsvLogs, ParseResult } from '../utils/logParser';
import { importLogs } from '../services/logsService';
import { toErrorMessage, API_BASE_URL } from '../services/api';
import {
  LOG_FORMAT_TEMPLATE_CSV,
  LOG_FORMAT_TEMPLATE_JSON,
} from '../utils/logFormatTemplate';
import { formatDateTime, getEventTypeLabel } from '../utils/formatters';
import { SeverityBadge } from '../components/common/StatusBadge';

interface ImportProps {
  onImportSuccess: () => void;
}

export const Import: React.FC<ImportProps> = ({ onImportSuccess }) => {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [importStatus, setImportStatus] = useState<{
    success?: boolean;
    message?: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const processFile = async (file: File) => {
    setSelectedFile(file);
    setImportStatus(null);
    setIsProcessing(true);

    try {
      const text = await file.text();
      let result: ParseResult;

      if (file.name.endsWith('.json')) {
        result = parseJsonLogs(text);
      } else if (file.name.endsWith('.csv') || file.name.endsWith('.txt')) {
        result = parseCsvLogs(text);
      } else {
        // Try JSON first, fallback to CSV
        try {
          result = parseJsonLogs(text);
          if (result.validEvents.length === 0 && result.errors.length > 0) {
            result = parseCsvLogs(text);
          }
        } catch {
          result = parseCsvLogs(text);
        }
      }

      setParseResult(result);
    } catch (err) {
      setParseResult({
        validEvents: [],
        errors: [{ line: 0, message: 'Falha ao ler arquivo', raw: '' }],
        warnings: [],
        totalParsed: 0,
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!parseResult || parseResult.validEvents.length === 0) return;

    setIsSending(true);
    setImportStatus(null);

    try {
      const result = await importLogs(parseResult.validEvents);
      const ignored = result.ignoredCount ?? 0;

      setImportStatus({
        success: true,
        message:
          `${result.importedCount} evento(s) enviados e persistidos pelo backend.` +
          (ignored > 0 ? ` ${ignored} ignorado(s) por duplicidade.` : '') +
          ' O dashboard foi atualizado.',
      });
      setSelectedFile(null);
      setParseResult(null);
      onImportSuccess();
    } catch (err) {
      setImportStatus({
        success: false,
        message: `Falha ao enviar os logs para o backend: ${toErrorMessage(err)}`,
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleDownloadTemplate = (type: 'json' | 'csv') => {
    const content =
      type === 'json' ? LOG_FORMAT_TEMPLATE_JSON : LOG_FORMAT_TEMPLATE_CSV;
    const blob = new Blob([content], {
      type: type === 'json' ? 'application/json' : 'text/csv',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `modelo_formato_logs.${type}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Page Header */}
      <div className="bg-white p-5 rounded-xl border border-[#E4ECE6]">
        <h2 className="text-base font-bold text-[#245C43]">
          Importação de Logs do Carrinho
        </h2>
        <p className="text-xs text-[#78877D]">
          Carregue arquivos de telemetria nos formatos JSON ou CSV gerados pelo sistema embarcado do carrinho.
        </p>
      </div>

      {/* Destino da importação */}
      <div className="p-4 bg-[#F0F7F3] rounded-xl border border-[#E4ECE6]">
        <div className="text-xs font-bold text-[#245C43]">
          Destino dos registros:{' '}
          <span className="font-mono font-semibold text-[#25372D]">
            POST {API_BASE_URL}/logs/import
          </span>
        </div>
        <p className="text-xs text-[#78877D] mt-0.5">
          A leitura e validação do arquivo acontecem no seu navegador. Ao confirmar, os
          eventos válidos são enviados ao backend, que é quem os persiste e passa a
          servi-los ao dashboard.
        </p>
      </div>

      {/* Success / Error notification */}
      {importStatus && (
        <div
          className={`p-4 rounded-xl border text-xs flex items-center justify-between ${
            importStatus.success
              ? 'bg-[#DDF4E5] border-[#BFE8D0] text-[#245C43]'
              : 'bg-[#FDEDEC] border-[#F5B7B1] text-[#922B21]'
          }`}
        >
          <div className="flex items-center gap-2">
            {importStatus.success ? (
              <CheckCircle2 className="w-4 h-4 text-[#4AAB79]" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-[#D96B6B]" />
            )}
            <span className="font-medium">{importStatus.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setImportStatus(null)}
            className="p-1 hover:opacity-75"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Upload Drop Zone */}
      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`p-8 rounded-2xl border-2 border-dashed text-center cursor-pointer transition-all ${
          dragActive
            ? 'border-[#245C43] bg-[#DDF4E5]/40'
            : 'border-[#BFE8D0] bg-white hover:border-[#65B98A]'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.csv,.txt"
          onChange={handleFileSelect}
          className="hidden"
        />

        <div className="w-12 h-12 rounded-2xl bg-[#F0F7F3] text-[#245C43] mx-auto flex items-center justify-center mb-3">
          <UploadCloud className="w-6 h-6" />
        </div>

        <h3 className="text-sm font-bold text-[#25372D] mb-1">
          Arraste o arquivo de logs aqui ou clique para selecionar
        </h3>
        <p className="text-xs text-[#78877D] max-w-sm mx-auto mb-4">
          Formatos suportados: <strong>.json</strong> (array de eventos ou json lines) ou <strong>.csv</strong> (com delimitadores por vírgula ou ponto-e-vírgula).
        </p>

        <div className="inline-flex items-center gap-4 text-xs text-[#78877D] font-mono">
          <span className="flex items-center gap-1">
            <FileCode className="w-3.5 h-3.5 text-[#245C43]" /> JSON
          </span>
          <span>·</span>
          <span className="flex items-center gap-1">
            <FileSpreadsheet className="w-3.5 h-3.5 text-[#245C43]" /> CSV
          </span>
        </div>
      </div>

      {/* Format Templates Download Box */}
      <div className="p-4 bg-white rounded-xl border border-[#E4ECE6] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h4 className="text-xs font-bold text-[#25372D]">
            Referência de formato esperado
          </h4>
          <p className="text-xs text-[#78877D]">
            Modelos com a estrutura de campos aceita pelo parser — úteis para quem for
            implementar a exportação de logs. Contêm apenas marcadores, não dados
            operacionais.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => handleDownloadTemplate('json')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E4ECE6] text-xs font-medium text-[#25372D] hover:bg-[#F7FAF8] transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-[#245C43]" />
            <span>Modelo JSON</span>
          </button>

          <button
            type="button"
            onClick={() => handleDownloadTemplate('csv')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E4ECE6] text-xs font-medium text-[#25372D] hover:bg-[#F7FAF8] transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-[#245C43]" />
            <span>Modelo CSV</span>
          </button>
        </div>
      </div>

      {/* Validation & Preview Section */}
      {parseResult && (
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5 space-y-5 animate-in fade-in duration-150">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[#E4ECE6]">
            <div>
              <h3 className="text-sm font-bold text-[#25372D]">
                Resultado da Validação: {selectedFile?.name}
              </h3>
              <p className="text-xs text-[#78877D]">
                Analise os dados extraídos antes de confirmar a aplicação ao dashboard.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setSelectedFile(null);
                  setParseResult(null);
                }}
                className="px-3 py-1.5 text-xs font-medium text-[#78877D] hover:text-[#25372D] rounded-lg transition-colors"
              >
                Cancelar
              </button>

              <button
                type="button"
                onClick={handleConfirmImport}
                disabled={parseResult.validEvents.length === 0 || isSending}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-[#245C43] bg-[#BFE8D0] hover:bg-[#aee0c2] transition-colors disabled:opacity-40 shadow-xs"
              >
                <Check className="w-4 h-4" />
                <span>
                  {isSending
                    ? 'Enviando ao backend...'
                    : `Enviar ${parseResult.validEvents.length} Logs`}
                </span>
              </button>
            </div>
          </div>

          {/* Validation Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-3 bg-[#F0F7F3] rounded-lg border border-[#E4ECE6]">
              <span className="text-xs text-[#78877D] block mb-1">Total Lidos</span>
              <span className="text-xl font-bold font-mono tabular-nums text-[#25372D]">
                {parseResult.totalParsed}
              </span>
            </div>

            <div className="p-3 bg-[#DDF4E5] rounded-lg border border-[#BFE8D0]">
              <span className="text-xs text-[#245C43] block mb-1">Registros Válidos</span>
              <span className="text-xl font-bold font-mono tabular-nums text-[#245C43]">
                {parseResult.validEvents.length}
              </span>
            </div>

            <div
              className={`p-3 rounded-lg border ${
                parseResult.errors.length > 0
                  ? 'bg-[#FDEDEC] border-[#F5B7B1]'
                  : 'bg-[#F7FAF8] border-[#E4ECE6]'
              }`}
            >
              <span className="text-xs text-[#78877D] block mb-1">Linhas com Inconsistência</span>
              <span
                className={`text-xl font-bold font-mono tabular-nums ${
                  parseResult.errors.length > 0 ? 'text-[#D96B6B]' : 'text-[#78877D]'
                }`}
              >
                {parseResult.errors.length}
              </span>
            </div>
          </div>

          {/* Errors list if any */}
          {parseResult.errors.length > 0 && (
            <div className="p-4 bg-[#FDEDEC]/50 rounded-xl border border-[#F5B7B1] space-y-2">
              <div className="flex items-center gap-2 text-xs font-bold text-[#922B21]">
                <AlertTriangle className="w-4 h-4" />
                <span>Linhas ignoradas devido a erro de formato ou campos obrigatórios:</span>
              </div>
              <ul className="text-xs text-[#78877D] space-y-1 max-h-32 overflow-y-auto font-mono">
                {parseResult.errors.map((err, i) => (
                  <li key={i}>
                    Linha {err.line}: {err.message} ({err.raw})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Preview Table */}
          {parseResult.validEvents.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[#78877D] uppercase tracking-wider mb-2">
                <Eye className="w-3.5 h-3.5 text-[#245C43]" />
                <span>Pré-visualização dos Primeiros 5 Eventos</span>
              </div>

              <div className="overflow-x-auto border border-[#E4ECE6] rounded-lg">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#F7FAF8] border-b border-[#E4ECE6] text-[#78877D] text-[11px] font-semibold">
                    <tr>
                      <th className="py-2 px-3">Horário</th>
                      <th className="py-2 px-3">Missão</th>
                      <th className="py-2 px-3">Tipo</th>
                      <th className="py-2 px-3">Comando</th>
                      <th className="py-2 px-3">Severidade</th>
                      <th className="py-2 px-3">Mensagem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E4ECE6]">
                    {parseResult.validEvents.slice(0, 5).map((e, idx) => (
                      <tr key={idx} className="hover:bg-[#F0F7F3]/30">
                        <td className="py-2 px-3 font-mono tabular-nums text-[#78877D]">
                          {formatDateTime(e.timestamp)}
                        </td>
                        <td className="py-2 px-3 font-mono font-bold text-[#245C43]">
                          {e.missionId}
                        </td>
                        <td className="py-2 px-3 font-medium text-[#25372D]">
                          {getEventTypeLabel(e.eventType)}
                        </td>
                        <td className="py-2 px-3 font-mono text-[11px]">
                          {e.command || '—'}
                        </td>
                        <td className="py-2 px-3">
                          <SeverityBadge severity={e.severity} />
                        </td>
                        <td className="py-2 px-3 text-[#25372D] max-w-xs truncate">
                          {e.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
