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

// Detecta telefone "lixo" (placeholder) que NÃO deve ser usado para casar clientes.
// Ex.: 00000000000, 0000000000, 51999999999, 99999999999, 5195599559, sequências repetidas.
// Quando o telefone é lixo, o sync trata como "sem telefone" e casa por nome+unidade,
// evitando recriar o mesmo cliente em loop.
function telefoneValido(tel) {
  if (!tel) return false
  const t = String(tel).replace(/\D/g, '')
  if (t.length < 10 || t.length > 11) return false
  if (/^0+$/.test(t)) return false                 // só zeros
  if (/^(\d)\1+$/.test(t)) return false            // todos os dígitos iguais (0000, 9999...)
  if (t === '51999999999' || t === '5195599559') return false // lixos conhecidos
  // celular com muitos 9 seguidos após o DDD (padrão de placeholder)
  if (/^\d{2}9{8,9}$/.test(t)) return false        // ex: 51 + 999999999
  return true
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

// Normaliza nome p/ comparação (minúsculo, sem acento, espaços únicos).
function normalizarNome(s) {
  return (s || '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ')
}

// Garante que um cliente já existente receba o código AppBarber se ainda não tiver.
async function garantirCodigo(clienteId, codigo) {
  if (!codigo || !clienteId) return
  try {
    await supabaseAdmin.from('clientes')
      .update({ appbarber_codigo: codigo }).eq('id', clienteId).is('appbarber_codigo', null)
  } catch (e) { /* silencioso */ }
}

// Acha um cliente existente (código AppBarber > telefone > nome+unidade) ou cria um novo.
// Evita duplicar: só cria quando NENHUMA das chaves casou.
// cacheTel evita repetir buscas no mesmo sync.
async function resolverCliente(m, unidadeId, cacheTel) {
  if (m.tipo !== 'agendamento') return { cliente_id: null, criado: false }
  const tel = normalizarTelefone(m.cliente_celular)
  // Só usa o telefone para casar se for VÁLIDO (não placeholder). Lixo -> casa por nome.
  const telOk = telefoneValido(tel)
  const tel11 = (telOk && tel && tel.length >= 11) ? tel.slice(-11) : null
  const codigo = m.cliente_codigo || null
  const nomeNorm = normalizarNome(m.cliente_nome)

  // 1) por CÓDIGO do AppBarber (chave mais confiável)
  if (codigo) {
    const ck = 'c:' + codigo
    if (cacheTel[ck]) return { cliente_id: cacheTel[ck], criado: false }
    const { data: ach } = await supabaseAdmin
      .from('clientes').select('id').eq('appbarber_codigo', codigo).limit(1)
    if (ach && ach.length) { cacheTel[ck] = ach[0].id; return { cliente_id: ach[0].id, criado: false } }
  }

  // 2) por TELEFONE (últimos 11 dígitos)
  if (tel11) {
    const tk = 't:' + tel11
    if (cacheTel[tk]) { await garantirCodigo(cacheTel[tk], codigo); return { cliente_id: cacheTel[tk], criado: false } }
    const { data: ach } = await supabaseAdmin
      .from('clientes').select('id').ilike('whatsapp', `%${tel11}%`).limit(1)
    if (ach && ach.length) {
      cacheTel[tk] = ach[0].id
      await garantirCodigo(ach[0].id, codigo)
      return { cliente_id: ach[0].id, criado: false }
    }
  }

  // 3) sem telefone: por NOME exato na MESMA unidade (evita fantasma)
  if (nomeNorm) {
    const nk = 'n:' + unidadeId + ':' + nomeNorm
    if (cacheTel[nk]) { await garantirCodigo(cacheTel[nk], codigo); return { cliente_id: cacheTel[nk], criado: false } }
    const { data: ach } = await supabaseAdmin
      .from('clientes').select('id, nome').eq('unidade_pref', unidadeId).ilike('nome', m.cliente_nome).limit(5)
    const alvo = (ach || []).find(c => normalizarNome(c.nome) === nomeNorm)
    if (alvo) {
      cacheTel[nk] = alvo.id
      if (tel11) cacheTel['t:' + tel11] = alvo.id
      await garantirCodigo(alvo.id, codigo)
      return { cliente_id: alvo.id, criado: false }
    }
  }

  if (!m.cliente_nome) return { cliente_id: null, criado: false } // sem nome e sem match -> não cria

  // 4) cria de fato (guardando código, telefone e nome)
  // Se o telefone for lixo/placeholder, salva NULL (não polui a base nem cria falso match).
  const whatsappSalvar = telOk ? (m.cliente_celular || null) : null
  const { data: novo, error } = await supabaseAdmin
    .from('clientes')
    .insert({
      nome: m.cliente_nome,
      whatsapp: whatsappSalvar,
      appbarber_codigo: codigo,
      origem: 'appbarber',
      unidade_pref: unidadeId,
      ativo: true,
    })
    .select('id').single()
  if (error) throw error
  if (codigo) cacheTel['c:' + codigo] = novo.id
  if (tel11) cacheTel['t:' + tel11] = novo.id
  if (nomeNorm) cacheTel['n:' + unidadeId + ':' + nomeNorm] = novo.id
  return { cliente_id: novo.id, criado: true }
}

// Processa uma LISTA de agendamentos crus (já buscados) -> casa, cria cliente, grava.
async function processarAgendamentos(unidadeId, bruto) {
  if (!Array.isArray(bruto)) bruto = []
  const { profMap, servMap } = await carregarDeParas(unidadeId)

  const cacheTel = {}
  const registros = []
  let novosClientes = 0, pendentes = 0, agendamentos = 0, bloqueios = 0

  for (const raw of bruto) {
    const m = mapearAgendamento(raw, { unidade_id: unidadeId })
    // Não importa BLOQUEIOS do AppBarber — só agendamentos de verdade (com cliente).
    // (bloqueio no AppBarber serve só pra tampar o horário lá; aqui a marcação real já existe)
    if (m.tipo === 'agendamento') { agendamentos++ } else { bloqueios++; continue }

    const colaborador_id = profMap[String(m.profissional_appbarber_id)] || null
    const servico_id = servMap[String(m.servico_codigo)] || null

    const { cliente_id, criado } = await resolverCliente(m, unidadeId, cacheTel)
    if (criado) novosClientes++

    const reg = construirRegistro(m, { unidade_id: unidadeId, colaborador_id, servico_id, cliente_id })
    if (reg.pendente_vinculo) pendentes++
    registros.push(reg)
  }

  // remove duplicatas de appbarber_id no MESMO lote (o AppBarber às vezes
  // repete o mesmo item entre dias) — senão o upsert dá
  // "ON CONFLICT cannot affect row a second time". Fica com a última ocorrência.
  const porId = new Map()
  for (const r of registros) porId.set((r.unidade_id || '') + ':' + r.appbarber_id, r)
  const registrosUnicos = Array.from(porId.values())

  // PROTEÇÃO: não re-importa por cima de quem JÁ foi finalizado OU editado
  // (movido/cancelado) no sistema novo — senão o AppBarber sobrescreve.
  try {
    const ids = registrosUnicos.map(r => r.appbarber_id).filter(Boolean)
    if (ids.length) {
      const { data: jaFinal } = await supabaseAdmin
        .from('agenda_appbarber')
        .select('appbarber_id')
        .eq('unidade_id', unidadeId)
        .or('finalizado.eq.true,editado_local.eq.true')
        .in('appbarber_id', ids)
      const setFinal = new Set((jaFinal || []).map(x => String(x.appbarber_id)))
      if (setFinal.size) {
        for (let i = registrosUnicos.length - 1; i >= 0; i--) {
          if (setFinal.has(String(registrosUnicos[i].appbarber_id))) registrosUnicos.splice(i, 1)
        }
      }
    }
  } catch (e) { /* se a checagem falhar, segue (melhor importar do que travar o sync) */ }

  // grava em lotes (upsert por appbarber_id -> não duplica).
  // Se o lote falhar (ex.: 1 registro com dado inválido), tenta um a um
  // pra não perder o lote inteiro — e registra quais falharam e por quê.
  let gravados = 0
  const falhas = []
  if (registrosUnicos.length) {
    const { error } = await supabaseAdmin
      .from('agenda_appbarber')
      .upsert(registrosUnicos, { onConflict: 'unidade_id,appbarber_id' })
    if (!error) {
      gravados = registrosUnicos.length
    } else {
      for (const r of registrosUnicos) {
        const { error: e1 } = await supabaseAdmin
          .from('agenda_appbarber')
          .upsert(r, { onConflict: 'unidade_id,appbarber_id' })
        if (e1) {
          falhas.push({
            appbarber_id: r.appbarber_id,
            motivo: (e1.message || e1.details || e1.hint || e1.code || 'erro'),
          })
        } else {
          gravados++
        }
      }
    }
  }

  // ============================================================
  // CANCELAMENTO POR AUSÊNCIA (item 2):
  // Quando o cliente cancela no AppBarber, o horário SOME de lá.
  // Detectamos os agendamentos que estavam no espelho para este dia/unidade
  // mas NÃO vieram nesta captura -> foram cancelados na origem.
  // Regras defensivas:
  //  - só roda se a captura trouxe agendamentos (evita captura falha/vazia apagar tudo)
  //  - só mexe em tipo 'agendamento' com status 'agendado' (não toca em realizado/concluído)
  //  - respeita finalizado/editado_local (não mexe no que já foi atendido/pago no sistema)
  let cancelados_por_ausencia = 0
  try {
    // ids de agendamentos (não bloqueios) que VIERAM nesta captura
    const idsVindos = new Set(
      registrosUnicos
        .filter(r => r.tipo === 'agendamento' && r.appbarber_id)
        .map(r => String(r.appbarber_id))
    )
    // profissionais que apareceram na captura (só cancelamos ausências DESTES,
    // pra não afetar barbeiros que por acaso não vieram numa captura parcial)
    const profsVindos = new Set(
      registrosUnicos
        .filter(r => r.tipo === 'agendamento' && r.colaborador_id)
        .map(r => String(r.colaborador_id))
    )
    // intervalo de datas coberto pela captura (do menor ao maior 'inicio')
    const inicios = registrosUnicos.map(r => r.inicio).filter(Boolean).sort()
    if (idsVindos.size > 0 && inicios.length > 0 && profsVindos.size > 0) {
      const diaIni = inicios[0].slice(0, 10) + ' 00:00:00'
      const diaFim = inicios[inicios.length - 1].slice(0, 10) + ' 23:59:59'
      // busca no espelho os agendamentos daquele dia/unidade ainda 'agendado'
      const { data: noEspelho } = await supabaseAdmin
        .from('agenda_appbarber')
        .select('id, appbarber_id, colaborador_id')
        .eq('unidade_id', unidadeId)
        .eq('tipo', 'agendamento')
        .eq('status', 'agendado')
        .is('finalizado', false)
        .is('editado_local', false)
        .gte('inicio', diaIni)
        .lte('inicio', diaFim)
      const sumidos = (noEspelho || []).filter(e =>
        !idsVindos.has(String(e.appbarber_id))              // não veio na captura
        && e.colaborador_id                                  // tem barbeiro vinculado
        && profsVindos.has(String(e.colaborador_id))         // e o barbeiro FOI capturado
      )
      if (sumidos.length) {
        const idsSumidos = sumidos.map(s => s.id)
        const { error: ec } = await supabaseAdmin
          .from('agenda_appbarber')
          .update({ status: 'cancelado' })
          .in('id', idsSumidos)
        if (!ec) cancelados_por_ausencia = idsSumidos.length
      }
    }
  } catch (e) { /* não trava o sync se a detecção falhar */ }

  return {
    total: bruto.length,
    agendamentos,
    bloqueios,
    novos_clientes: novosClientes,
    pendentes_de_vinculo: pendentes,
    gravados,
    cancelados_por_ausencia,
    falhas: falhas.length,
    detalhe_falhas: falhas.slice(0, 3),
  }
}

// Sincroniza UMA unidade para UM dia (servidor busca — usado se o cookie valer no IP do servidor).
async function sincronizarUnidade(unidadeId, cookie, dia) {
  const { profMap } = await carregarDeParas(unidadeId)
  const profIds = Object.keys(profMap)
  if (!profIds.length) throw new Error('Unidade sem profissionais no de-para')
  const bruto = await buscarAgenda(cookie, dia, profIds)
  const r = await processarAgendamentos(unidadeId, bruto)
  return { unidade_id: unidadeId, dia, ...r }
}

module.exports = { sincronizarUnidade, processarAgendamentos, construirRegistro, normalizarTelefone, carregarDeParas }
