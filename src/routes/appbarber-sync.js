// ============================================================================
// appbarber-sync.js
// Lê a agenda de uma unidade no AppBarber (via cookie) e grava no Sistema 1989:
//  - casa/cria o cliente (marcando origem='appbarber'), casando por celular
//  - casa barbeiro e serviço pelo de-para
//  - grava o horário na tabela agenda_appbarber (espelho somente-leitura)
// Requer Node 18+. Sem dependências externas além do supabaseAdmin do projeto.
// ============================================================================

const { supabaseAdmin } = require('../config/supabase')
const { buscarAgenda } = require('./appbarber-client')
const { mapearAgendamento } = require('./appbarber-mapper')

// "51999202192.0" -> "51999202192" | "(51) 99920-2192" -> "51999202192"
function normalizarTelefone(s) {
  if (!s) return null
  let t = String(s).trim()
  t = t.replace(/\.\d+$/, '')        // tira sufixo decimal ".0"
  t = t.replace(/\D/g, '')           // só dígitos
  if (t.length >= 12 && t.startsWith('55')) t = t.slice(2) // tira DDI 55
  return t || null
}

// Monta o registro EXATAMENTE com as colunas da tabela agenda_appbarber.
// (função pura — fácil de testar)
function construirRegistro(m, vinc) {
  const ehAgendamento = m.tipo === 'agendamento'
  const pendente = ehAgendamento && (!vinc.colaborador_id || !vinc.servico_id)
  return {
    appbarber_id: m.appbarber_id,
    unidade_id: vinc.unidade_id,
    tipo: m.tipo,
    status: m.status,
    cod_status: m.cod_status,

    cliente_nome: m.cliente_nome,
    cliente_celular: m.cliente_celular,
    cliente_codigo: m.cliente_codigo,
    cliente_id: vinc.cliente_id || null,

    profissional_appbarber_id: m.profissional_appbarber_id,
    colaborador_id: vinc.colaborador_id || null,

    servico_texto: m.servico,
    servico_appbarber_id: m.servico_codigo,
    servico_id: vinc.servico_id || null,

    inicio: m.inicio,
    fim: m.fim,
    valor: m.valor,

    observacao: m.observacao,
    confirmado: m.confirmado,
    encaixe: m.encaixe,
    cor: m.cor,
    comanda_codigo: m.comanda_codigo,

    pendente_vinculo: pendente,
    sincronizado_em: new Date().toISOString(),
  }
}

// Carrega os de-para da unidade -> { profMap: {abId:colab_id}, servMap: {abId:serv_id} }
async function carregarDeParas(unidadeId) {
  const [prof, serv] = await Promise.all([
    supabaseAdmin.from('appbarber_depara_profissional').select('appbarber_id, colaborador_id').eq('unidade_id', unidadeId),
    supabaseAdmin.from('appbarber_depara_servico').select('appbarber_id, servico_id').eq('unidade_id', unidadeId),
  ])
  if (prof.error) throw prof.error
  if (serv.error) throw serv.error
  const profMap = {}, servMap = {}
  for (const p of prof.data) profMap[String(p.appbarber_id)] = p.colaborador_id
  for (const s of serv.data) servMap[String(s.appbarber_id)] = s.servico_id
  return { profMap, servMap }
}

// Acha um cliente pelo celular (normalizado) ou cria um novo (origem=appbarber).
// cacheTel evita criar 2x o mesmo cliente no mesmo sync.
// Retorna { cliente_id, criado } — 'criado' = true se um novo cliente foi cadastrado.
async function resolverCliente(m, unidadeId, cacheTel) {
  if (m.tipo !== 'agendamento') return { cliente_id: null, criado: false }
  const tel = normalizarTelefone(m.cliente_celular)

  if (tel) {
    if (cacheTel[tel]) return { cliente_id: cacheTel[tel], criado: false }
    const { data: achados } = await supabaseAdmin
      .from('clientes').select('id').ilike('whatsapp', `%${tel}%`).limit(1)
    if (achados && achados.length) {
      cacheTel[tel] = achados[0].id
      return { cliente_id: achados[0].id, criado: false }
    }
  }

  if (!m.cliente_nome) return { cliente_id: null, criado: false } // sem nome e sem match -> não cria

  const { data: novo, error } = await supabaseAdmin
    .from('clientes')
    .insert({
      nome: m.cliente_nome,
      whatsapp: m.cliente_celular || null,
      origem: 'appbarber',
      unidade_pref: unidadeId,
      ativo: true,
    })
    .select('id').single()
  if (error) throw error
  if (tel) cacheTel[tel] = novo.id
  return { cliente_id: novo.id, criado: true }
}

// Sincroniza UMA unidade para UM dia.
async function sincronizarUnidade(unidadeId, cookie, dia) {
  // 1) IDs dos profissionais (vêm do de-para já carregado nas tabelas)
  const { profMap, servMap } = await carregarDeParas(unidadeId)
  const profIds = Object.keys(profMap)
  if (!profIds.length) throw new Error('Unidade sem profissionais no de-para')

  // 2) lê a agenda do AppBarber
  const bruto = await buscarAgenda(cookie, dia, profIds)

  // 3) processa cada item
  const cacheTel = {}
  const registros = []
  let novosClientes = 0, pendentes = 0, agendamentos = 0, bloqueios = 0

  for (const raw of bruto) {
    const m = mapearAgendamento(raw, { unidade_id: unidadeId })
    if (m.tipo === 'agendamento') agendamentos++; else bloqueios++

    const colaborador_id = profMap[String(m.profissional_appbarber_id)] || null
    const servico_id = servMap[String(m.servico_codigo)] || null

    const { cliente_id, criado } = await resolverCliente(m, unidadeId, cacheTel)
    if (criado) novosClientes++

    const reg = construirRegistro(m, { unidade_id: unidadeId, colaborador_id, servico_id, cliente_id })
    if (reg.pendente_vinculo) pendentes++
    registros.push(reg)
  }

  // 4) grava tudo (upsert por appbarber_id -> não duplica)
  if (registros.length) {
    const { error } = await supabaseAdmin
      .from('agenda_appbarber')
      .upsert(registros, { onConflict: 'appbarber_id' })
    if (error) throw error
  }

  return {
    unidade_id: unidadeId,
    dia: dia,
    total: bruto.length,
    agendamentos,
    bloqueios,
    novos_clientes: novosClientes,
    pendentes_de_vinculo: pendentes,
    gravados: registros.length,
  }
}

module.exports = { sincronizarUnidade, construirRegistro, normalizarTelefone, carregarDeParas }
