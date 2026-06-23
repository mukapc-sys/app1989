// ============================================================================
// appbarber-mapper.js
// Traduz um agendamento no formato do AppBarber para o formato do Sistema 1989.
// Sem dependências externas. Funções puras (fáceis de testar).
// ============================================================================

// "50,00" -> 50.00  |  "1.234,56" -> 1234.56  |  "" -> 0
function parseValorBR(v) {
  if (v == null || v === '') return 0
  const s = String(v).trim().replace(/\./g, '').replace(',', '.')
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}

// AppBarber manda a hora LOCAL (Brasília) sem fuso (formato FullCalendar).
// Marcamos como -03:00 para o banco guardar o instante correto — senão fica 3h deslocado.
function horaBR(s) {
  if (!s) return s
  s = String(s).trim()
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return s          // não é data-hora -> não mexe
  if (/[Zz]$|[+\-]\d{2}:?\d{2}$/.test(s)) return s.replace(' ', 'T')  // já tem fuso -> mantém
  s = s.replace(' ', 'T')
  if (/T\d{2}:\d{2}$/.test(s)) s += ':00'                             // sem segundos -> completa
  return s + '-03:00'
}

// codStatus do AppBarber -> rótulo do nosso sistema
const STATUS_MAP = {
  1: 'agendado',
  2: 'realizado',
  3: 'cancelado',
  4: 'bloqueio',
}

// Um item do AppBarber é um "bloqueio" (folga/intervalo) e não um cliente?
function ehBloqueio(raw) {
  if (String(raw.codStatus) === '4') return true
  if (String(raw.title || '').trim().toUpperCase() === 'BLOQUEADO') return true
  return false
}

/**
 * Converte um agendamento cru do AppBarber no nosso registro espelho.
 * @param {object} raw  - item do array retornado por buscaAgenda3.php
 * @param {object} ctx  - { unidade_id, profissionais } onde profissionais é
 *                         um mapa { [Pes_Codigo]: Pes_Nome }
 */
function mapearAgendamento(raw, ctx = {}) {
  const profId = raw.resources != null ? String(raw.resources) : null
  const profNome = (ctx.profissionais && profId && ctx.profissionais[profId]) || null
  const bloqueio = ehBloqueio(raw)

  return {
    // chave única p/ deduplicar entre sincronizações (upsert por aqui)
    appbarber_id: String(raw.id),
    unidade_id: ctx.unidade_id || null,

    tipo: bloqueio ? 'bloqueio' : 'agendamento',
    status: STATUS_MAP[Number(raw.codStatus)] || (raw.status || '').toLowerCase() || 'desconhecido',
    cod_status: raw.codStatus != null ? Number(raw.codStatus) : null,

    // quem
    cliente_nome: bloqueio ? null : (raw.title || '').trim() || null,
    cliente_celular: (raw.celular || '').trim() || null,
    cliente_codigo: (raw.codCliente || '') !== '' ? String(raw.codCliente) : null,

    // profissional
    profissional_appbarber_id: profId,
    profissional_nome: profNome,

    // quando
    inicio: horaBR(raw.start),
    fim: horaBR(raw.end),

    // o quê
    servico: (raw.servico || '').trim() || null,
    servico_codigo: (raw.sercodigo || '') !== '' ? String(raw.sercodigo) : null,
    valor: parseValorBR(raw.valor),

    // extras úteis
    observacao: (raw.obs || '').trim() || null,
    confirmado: String(raw.Age_Confirmado) === '1',
    encaixe: String(raw.Encaixe) === '1',
    cor: raw.color || null,
    comanda_codigo: (raw.Com_Codigo || '') !== '' ? String(raw.Com_Codigo) : null,

    // controle interno
    origem: 'appbarber',
    somente_leitura: true,
  }
}

/** Mapeia a lista inteira retornada pela agenda. */
function mapearAgenda(lista, ctx = {}) {
  if (!Array.isArray(lista)) return []
  return lista.map((item) => mapearAgendamento(item, ctx))
}

module.exports = { mapearAgendamento, mapearAgenda, parseValorBR, ehBloqueio, STATUS_MAP }
