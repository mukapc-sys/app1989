// ============================================================================
// appbarber-client.js
// Cliente HTTP que conversa com o site interno do AppBarber usando um COOKIE
// de sessão já obtido (o login com reCAPTCHA é feito por uma pessoa).
// Requer Node 18+ (fetch global). Sem dependências externas.
// ============================================================================

const BASE = 'https://sistema.appbarber.com.br'

// Cabeçalhos que imitam o navegador (o site exige X-Requested-With p/ responder JSON)
function headers(cookie) {
  return {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Referer': BASE + '/index.php',
    'Cookie': cookie,
  }
}

// dd/mm/aaaa  (formato que o buscaAgenda3.php espera no campo "dia")
function formatarDiaBR(date) {
  const d = new Date(date)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}/${mm}/${yyyy}`
}

// Lê a lista de profissionais da unidade (id -> nome) e devolve também os IDs
async function buscarProfissionais(cookie) {
  const resp = await fetch(`${BASE}/pages/actions/buscaProfissionais.php`, {
    method: 'GET',
    headers: headers(cookie),
  })
  if (!resp.ok) throw new Error(`buscaProfissionais HTTP ${resp.status}`)
  const data = await resp.json()
  const lista = (data && data.profissionais) || []
  const mapa = {}
  const ids = []
  for (const p of lista) {
    const id = String(p.Pes_Codigo)
    mapa[id] = p.Pes_Nome
    ids.push(id)
  }
  return { mapa, ids }
}

// Busca a agenda de um dia para um conjunto de profissionais.
// dia: Date ou 'aaaa-mm-dd' ; profissionalIds: array de strings/números
async function buscarAgenda(cookie, dia, profissionalIds) {
  const body = new URLSearchParams()
  for (const id of profissionalIds) body.append('profissional[]', String(id))
  body.append('tipo', '1')
  body.append('dia', formatarDiaBR(dia))

  const resp = await fetch(`${BASE}/pages/actions/buscaAgenda3.php`, {
    method: 'POST',
    headers: headers(cookie),
    body: body.toString(),
  })
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('SESSAO_EXPIRADA') // cookie caiu -> precisa relogar
  }
  if (!resp.ok) throw new Error(`buscaAgenda3 HTTP ${resp.status}`)

  const texto = await resp.text()
  // Se a sessão caiu, o site costuma devolver HTML de login em vez de JSON
  let json
  try {
    json = JSON.parse(texto)
  } catch {
    throw new Error('SESSAO_EXPIRADA')
  }
  if (!Array.isArray(json)) throw new Error('SESSAO_EXPIRADA')
  return json
}

module.exports = { buscarProfissionais, buscarAgenda, formatarDiaBR, BASE }
