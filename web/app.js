// Dashboard do gestor (M7). Sem framework e sem build: módulos ES servidos pela própria API.
// Todo texto vindo do banco entra como texto (textContent), nunca como HTML.

const principal = document.getElementById('principal');
const lateral = document.getElementById('lateral');
const gaveta = document.getElementById('gaveta');
const fundoGaveta = document.getElementById('fundo-gaveta');
const avisos = document.getElementById('avisos');
const conta = document.getElementById('conta');
const seletorTime = document.getElementById('time');
const corpo = document.querySelector('.corpo');

const estado = { times: [], timeId: null, dailies: [], mes: null, deslogado: false };

// ------------------------------------------------------------------ utilidades

/** Cria um elemento. `props`: class, text, href, on<evento>, atributos; filhos nulos são ignorados. */
function el(tag, props = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...filhos.flat(3).filter((f) => f !== null && f !== undefined && f !== false));
  return e;
}

const ICONES = {
  check: 'M20 6 9 17l-5-5',
  seta: 'M5 12h14M13 6l6 6-6 6',
  bloqueio: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM5.6 5.6l12.8 12.8',
  resolvido: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8 12l3 3 5-6',
  calendario: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
  busca: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-3.6-3.6',
  relogio: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2',
  pessoas: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 7M22 21a7 7 0 0 0-4-6.3',
  decisao: 'M5 21V4M5 4h12l-2 4 2 4H5',
  pendencia: 'M4 7l2 2 3-3M4 16l2 2 3-3M13 7h7M13 17h7',
  fala: 'M4 5h16v11H9l-5 4V5Z',
  documento: 'M7 3h7l5 5v13H7V3ZM14 3v5h5M10 13h6M10 17h6',
  x: 'M6 6l12 12M18 6 6 18',
  atualizar: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  sair: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10',
  esquerda: 'M15 6l-6 6 6 6',
  direita: 'M9 6l6 6-6 6',
  brilho: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z',
  vazio: 'M4 13h4l2 3h4l2-3h4M4 13l3-8h10l3 8v6H4v-6Z',
};

function icone(nome, classe = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icone ${classe}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const caminho = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  caminho.setAttribute('d', ICONES[nome]);
  svg.append(caminho);
  return svg;
}

/** Avatar com as iniciais; a cor é derivada do nome, então a mesma pessoa tem sempre a mesma. */
function avatar(nome, tamanho = '') {
  const palavras = String(nome).trim().split(/\s+/).filter(Boolean);
  const iniciais = ((palavras[0]?.[0] ?? '?') + (palavras.length > 1 ? palavras.at(-1)[0] : (palavras[0]?.[1] ?? ''))).toUpperCase();
  let h = 0;
  for (const c of String(nome)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return el('span', { class: `av av-${h % 8} ${tamanho}`.trim(), 'aria-hidden': 'true', text: iniciais });
}

async function api(caminho, opcoes) {
  const r = await fetch(`/api${caminho}`, opcoes);
  const corpoResposta = await r.json().catch(() => null);
  if (r.status === 401) telaLogin(); // a sessão acabou no meio do uso
  if (!r.ok) throw new Error(corpoResposta?.erro?.mensagem ?? `Erro ${r.status}`);
  return corpoResposta;
}

function avisar(mensagem, tipo = '') {
  const aviso = el('div', { class: `aviso ${tipo}`.trim(), text: mensagem });
  avisos.append(aviso);
  setTimeout(() => aviso.remove(), 4500);
}

const dataBr = (d) => d.split('-').reverse().join('/');
const diaMes = (d) => dataBr(d).slice(0, 5);
const dataLonga = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const timeAtual = () => estado.times.find((t) => t.id === estado.timeId);
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: timeAtual()?.fusoHorario, hour: '2-digit', minute: '2-digit' });
const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: timeAtual()?.fusoHorario }).format(new Date());
const tempo = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

const STATUS = {
  GRAVANDO: 'gravando',
  AGUARDANDO_TRANSCRICAO: 'na fila para transcrever',
  TRANSCREVENDO: 'transcrevendo',
  AGUARDANDO_EXTRACAO: 'na fila para resumir',
  EXTRAINDO: 'gerando o resumo',
  CONCLUIDA: 'concluída',
  ERRO: 'com erro',
};
const emAndamento = (status) => status !== 'CONCLUIDA' && status !== 'ERRO';

function etiquetaStatus(status) {
  if (status === 'CONCLUIDA') return null;
  if (status === 'ERRO') return el('span', { class: 'etiqueta erro', text: STATUS.ERRO });
  return el('span', { class: 'etiqueta azul pulsando', text: STATUS[status] ?? status });
}

function vazio(nomeIcone, ...conteudo) {
  return el('div', { class: 'painel vazio' }, icone(nomeIcone), el('p', {}, conteudo));
}

// ------------------------------------------------------------------ rotas (hash)

/** "#/dias?ids=1,2" → { secao: 'dias', partes: [], q: URLSearchParams } */
function rota() {
  const [caminho, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [secao = 'dias', ...partes] = caminho.split('/').filter(Boolean);
  return { secao, partes, q: new URLSearchParams(query) };
}

function endereco(caminho, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== null && v !== undefined && v !== '') q.set(k, v);
  const texto = q.toString();
  return `#/${caminho}${texto ? `?${texto}` : ''}`;
}

function ir(caminho, params) {
  location.hash = endereco(caminho, params);
}

const link = (caminho, params, texto, props = {}) => el('a', { href: endereco(caminho, params), text: texto, ...props });

// ------------------------------------------------------------------ partes reutilizadas

/** Item do resumo: clicar abre a transcrição no trecho de origem. */
function item(i, dailyId, nota) {
  const semOrigem = !i.falaIds?.length;
  return el(
    'li',
    {},
    el(
      'button',
      {
        class: 'item',
        type: 'button',
        title: semOrigem ? 'Transcrição não disponível (prazo de retenção)' : 'Ver na transcrição',
        onclick: () => abrirTranscricao(dailyId, i.falaIds ?? []),
      },
      el('span', { class: 'texto' }, i.descricao, nota ? el('span', { class: 'nota' }, nota) : null),
      semOrigem ? null : icone('fala', 'ir'),
    ),
  );
}

function grupo(classe, nomeIcone, titulo, itens, dailyId, nota = () => null) {
  if (!itens?.length) return null;
  return el(
    'div',
    { class: `grupo ${classe}` },
    el('div', { class: 'grupo-titulo' }, el('span', { class: 'marca-cat' }, icone(nomeIcone)), titulo),
    el('ul', { class: 'itens' }, itens.map((i) => item(i, dailyId, nota(i)))),
  );
}

const notaBloqueio = (b) =>
  b.novo ? el('span', { class: 'etiqueta azul', text: 'novo' }) : el('span', { class: 'etiqueta ambar', text: `em aberto desde ${diaMes(b.desde)}` });

/** Fez / Vai fazer / Bloqueios de uma pessoa num dia. */
function blocoPessoa(p, dailyId) {
  const grupos = [
    grupo('fez', 'check', 'Fez', p.fez, dailyId),
    grupo('vai', 'seta', 'Vai fazer', p.vaiFazer, dailyId),
    grupo('bloqueio', 'bloqueio', 'Bloqueios', p.bloqueios, dailyId, notaBloqueio),
  ].filter(Boolean);
  return grupos.length ? grupos : [el('p', { class: 'suave', text: 'Nada reportado.' })];
}

const pessoaLinha = (p) => el('span', { class: 'pessoa-linha' }, avatar(p.nome, 'p'), link(`pessoa/${p.id}`, {}, p.nome));

async function abrirTranscricao(dailyId, falaIds = []) {
  const daily = estado.dailies.find((d) => d.id === dailyId);
  fundoGaveta.hidden = false;
  gaveta.hidden = false;
  gaveta.replaceChildren(
    el(
      'header',
      {},
      el('div', {}, el('strong', { text: 'Transcrição' }), daily ? el('small', { text: `${dataBr(daily.data)} · ${hora(daily.iniciadaEm)}` }) : null),
      el('button', { type: 'button', class: 'so-icone', 'aria-label': 'Fechar', title: 'Fechar (Esc)', onclick: fecharGaveta }, icone('x')),
    ),
  );
  try {
    const falas = await api(`/dailies/${dailyId}/transcricao`);
    const origem = new Set(falaIds);
    gaveta.append(
      falas.length
        ? el(
            'ol',
            {},
            falas.map((f) =>
              el(
                'li',
                { class: origem.has(f.id) ? 'fala origem' : 'fala' },
                avatar(f.participante.nome),
                el('span', { class: 'quem' }, f.participante.nome, el('span', { class: 'tempo', text: tempo(f.inicioMs) })),
                el('p', { text: f.texto }),
              ),
            ),
          )
        : el('div', { class: 'vazio' }, icone('vazio'), el('p', { text: 'Esta daily não tem transcrição: ninguém falou ou o prazo de retenção passou.' })),
    );
    gaveta.querySelector('.origem')?.scrollIntoView({ block: 'center' });
    gaveta.querySelector('button').focus();
  } catch (e) {
    gaveta.append(el('p', { class: 'vazio erro', text: e.message }));
  }
}

function fecharGaveta() {
  gaveta.hidden = true;
  fundoGaveta.hidden = true;
  gaveta.replaceChildren();
}

// ------------------------------------------------------------------ lateral: calendário e lista de dailies

function desenharLateral(selecionadas) {
  const sel = new Set(selecionadas);
  const porData = Map.groupBy(estado.dailies, (d) => d.data);
  const [ano, mes] = estado.mes.split('-').map(Number);
  const primeiro = new Date(Date.UTC(ano, mes - 1, 1));
  const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const dataHoje = hoje();
  const mudarMes = (delta) => {
    estado.mes = new Date(Date.UTC(ano, mes - 1 + delta, 1)).toISOString().slice(0, 7);
    desenharLateral(selecionadas);
  };

  const celulas = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((s) => el('span', { class: 'sem', text: s }));
  for (let i = 0; i < primeiro.getUTCDay(); i++) celulas.push(el('span'));
  for (let dia = 1; dia <= diasNoMes; dia++) {
    const data = `${estado.mes}-${String(dia).padStart(2, '0')}`;
    const doDia = porData.get(data) ?? [];
    const marcado = doDia.some((d) => sel.has(d.id));
    celulas.push(
      el('button', {
        type: 'button',
        text: String(dia),
        class: [doDia.length && 'tem', marcado && 'sel', data === dataHoje && 'hoje'].filter(Boolean).join(' '),
        disabled: !doDia.length,
        'aria-pressed': doDia.length ? String(marcado) : null,
        title: doDia.length ? `${plural(doDia.length, 'daily', 'dailies')} em ${dataBr(data)}` : null,
        onclick: () => ir('dias', { ids: doDia.map((d) => d.id).join(',') }),
      }),
    );
  }

  const doMes = estado.dailies.filter((d) => d.data.startsWith(estado.mes));
  const alternar = (id) => {
    sel.has(id) ? sel.delete(id) : sel.add(id);
    ir('dias', { ids: estado.dailies.filter((d) => sel.has(d.id)).map((d) => d.id).join(',') });
  };

  lateral.replaceChildren(
    el(
      'div',
      { class: 'cal-topo' },
      el('button', { type: 'button', class: 'so-icone', 'aria-label': 'Mês anterior', onclick: () => mudarMes(-1) }, icone('esquerda')),
      el('strong', { text: primeiro.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }),
      el('button', { type: 'button', class: 'so-icone', 'aria-label': 'Próximo mês', onclick: () => mudarMes(1) }, icone('direita')),
    ),
    el('div', { class: 'cal' }, celulas),
    doMes.length
      ? el(
          'div',
          {},
          el('span', { class: 'rotulo', text: 'Dailies do mês' }),
          el(
            'ul',
            { class: 'lista-dailies' },
            doMes.map((d) =>
              el(
                'li',
                {},
                el(
                  'label',
                  {},
                  el('input', { type: 'checkbox', checked: sel.has(d.id), onchange: () => alternar(d.id) }),
                  el('span', { text: diaMes(d.data) }),
                  etiquetaStatus(d.status),
                  el('span', { class: 'hora', text: hora(d.iniciadaEm) }),
                ),
              ),
            ),
          ),
        )
      : el('p', { class: 'dica', text: 'Nenhuma daily neste mês.' }),
    el('p', { class: 'dica', text: 'Marque duas ou mais para comparar lado a lado.' }),
  );
}

// ------------------------------------------------------------------ telas

let recarga = null;

async function telaDias(q) {
  const validas = new Set(estado.dailies.map((d) => d.id));
  let ids = (q.get('ids') ?? '').split(',').map(Number).filter((id) => validas.has(id));
  if (!ids.length && estado.dailies.length) ids = [estado.dailies.at(-1).id];
  if (!estado.mes || q.get('ids')) estado.mes = (estado.dailies.find((d) => d.id === ids[0])?.data ?? hoje()).slice(0, 7);
  desenharLateral(ids);

  if (!ids.length) {
    return [
      el('div', { class: 'pagina-topo' }, el('div', {}, el('span', { class: 'sobretitulo', text: timeAtual()?.nome ?? '' }), el('h1', { text: 'Dailies' }))),
      vazio('calendario', 'Nenhuma daily gravada neste time ainda. No Discord, entre num canal de voz e use ', el('code', { text: '/daily iniciar' }), '.'),
    ];
  }
  if (ids.length === 1) {
    const visao = await api(`/dailies/${ids[0]}`);
    // Link direto para uma fala (#/dias?ids=3&fala=7): já abre a transcrição naquele ponto.
    const fala = Number(q.get('fala'));
    if (fala) abrirTranscricao(visao.id, [fala]);
    return telaDia(visao);
  }
  return telaComparar(await api(`/dailies/comparar?ids=${ids.join(',')}`));
}

function telaDia(v) {
  const daily = estado.dailies.find((d) => d.id === v.id);
  const naoGravados = v.presentes.filter((p) => !p.gravado);
  const comItens = new Set(v.pessoas.map((p) => p.participante.id));
  const semAtualizacao = v.presentes.filter((p) => p.gravado && !comItens.has(p.id));
  const bloqueios = v.pessoas.reduce((n, p) => n + p.bloqueios.length, 0);

  // Enquanto a daily está sendo processada, a tela se atualiza sozinha.
  if (emAndamento(v.status)) {
    recarga = setTimeout(async () => {
      await carregarDailies().catch(() => {});
      desenhar();
    }, 5000);
  }

  const refazer = el(
    'button',
    {
      type: 'button',
      class: 'fantasma',
      title: 'Gera o resumo de novo a partir da transcrição',
      onclick: async () => {
        if (!confirm('Refazer o resumo desta daily? O resumo atual será substituído.')) return;
        refazer.disabled = true;
        try {
          await api(`/admin/dailies/${v.id}/reprocessar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"etapa":"EXTRAIR"}' });
          avisar('Resumo na fila: a tela atualiza quando ficar pronto.');
          await carregarDailies();
          desenhar();
        } catch (e) {
          avisar(e.message, 'erro');
          refazer.disabled = false;
        }
      },
    },
    icone('atualizar'),
    'Refazer resumo',
  );

  const indicador = (nomeIcone, valor, nome, alerta) =>
    el('div', { class: `indicador${alerta ? ' alerta' : ''}` }, el('span', { class: 'valor', text: String(valor) }), el('span', { class: 'nome' }, icone(nomeIcone), nome));

  return [
    el(
      'div',
      { class: 'pagina-topo' },
      el(
        'div',
        {},
        el('span', { class: 'sobretitulo', text: `Daily · ${v.time.nome}` }),
        el('h1', { text: dataLonga(v.data) }),
        el(
          'div',
          { class: 'meta' },
          daily ? el('span', {}, icone('relogio'), hora(daily.iniciadaEm)) : null,
          daily?.duracaoMin !== null && daily?.duracaoMin !== undefined ? el('span', { text: `${Math.max(1, daily.duracaoMin)} min` }) : null,
          etiquetaStatus(v.status),
        ),
      ),
      el(
        'div',
        { class: 'acoes' },
        el('button', { type: 'button', class: 'fantasma', onclick: () => abrirTranscricao(v.id) }, icone('documento'), 'Transcrição'),
        emAndamento(v.status) ? null : refazer,
      ),
    ),

    v.status === 'ERRO'
      ? el('div', { class: 'painel erro' }, `Não foi possível processar esta daily: ${v.erroMensagem ?? 'erro desconhecido'}`)
      : el(
          'section',
          { class: 'painel heroi' },
          el('span', { class: 'rotulo', text: 'Resumo do dia' }),
          el('p', { class: 'resumo-geral', text: v.resumoGeral ?? 'O resumo aparece aqui assim que a daily terminar de ser processada.' }),
          el(
            'div',
            { class: 'indicadores' },
            indicador('pessoas', v.presentes.length, 'presentes'),
            indicador('decisao', v.decisoes.length, v.decisoes.length === 1 ? 'decisão' : 'decisões'),
            indicador('pendencia', v.pendencias.length, v.pendencias.length === 1 ? 'pendência' : 'pendências'),
            indicador('bloqueio', bloqueios, bloqueios === 1 ? 'bloqueio citado' : 'bloqueios citados', bloqueios > 0),
          ),
        ),

    v.pessoas.length ? el('h2', {}, 'Por pessoa', el('span', { class: 'conta-itens', text: String(v.pessoas.length) })) : null,
    v.pessoas.length
      ? el(
          'div',
          { class: 'cards' },
          v.pessoas.map((p) =>
            el(
              'article',
              { class: 'painel card' },
              el('div', { class: 'card-topo' }, avatar(p.participante.nome), el('h3', {}, link(`pessoa/${p.participante.id}`, {}, p.participante.nome, { title: 'Ver o histórico da pessoa' }))),
              blocoPessoa(p, v.id),
            ),
          ),
        )
      : null,

    v.decisoes.length || v.pendencias.length || v.bloqueiosResolvidos.length
      ? el(
          'div',
          { class: 'duas-colunas' },
          v.decisoes.length
            ? el('section', { class: 'painel' }, el('h2', {}, icone('decisao'), 'Decisões'), el('ul', { class: 'itens' }, v.decisoes.map((i) => item(i, v.id))))
            : null,
          v.pendencias.length
            ? el(
                'section',
                { class: 'painel' },
                el('h2', {}, icone('pendencia'), 'Pendências'),
                el(
                  'ul',
                  { class: 'itens' },
                  v.pendencias.map((p) =>
                    item(p, v.id, [
                      p.responsavel ? el('span', { class: 'pessoa-linha' }, avatar(p.responsavel.nome, 'p'), p.responsavel.nome) : el('span', { text: 'sem responsável' }),
                      p.prazo ? el('span', { class: 'etiqueta', text: p.prazo }) : null,
                    ]),
                  ),
                ),
              )
            : null,
          v.bloqueiosResolvidos.length
            ? el(
                'section',
                { class: 'painel' },
                el('h2', {}, icone('resolvido'), 'Bloqueios resolvidos'),
                v.bloqueiosResolvidos.map((b) =>
                  el(
                    'div',
                    { class: 'item-fixo' },
                    icone('resolvido'),
                    el('div', {}, b.descricao, el('span', { class: 'nota' }, avatar(b.participante.nome, 'p'), `${b.participante.nome} · aberto desde ${diaMes(b.desde)}`)),
                  ),
                ),
              )
            : null,
        )
      : null,

    el(
      'div',
      { class: 'rodape-dia' },
      semAtualizacao.length ? el('span', { text: `Presentes sem atualização: ${semAtualizacao.map((p) => p.nome).join(', ')}` }) : null,
      naoGravados.length ? el('span', { text: `Presentes, não gravados: ${naoGravados.map((p) => p.nome).join(', ')}` }) : null,
      v.extracao ? el('span', { class: 'empurra', text: `Resumo gerado por ${v.extracao.modelo} · ${v.extracao.versaoPrompt}` }) : null,
    ),
  ];
}

function telaComparar(c) {
  return [
    el(
      'div',
      { class: 'pagina-topo' },
      el(
        'div',
        {},
        el('span', { class: 'sobretitulo', text: timeAtual()?.nome ?? '' }),
        el('h1', { text: 'Comparar dias' }),
        el('div', { class: 'meta' }, el('span', { text: `${c.dailies.length} dailies lado a lado, alinhadas por pessoa` })),
      ),
    ),
    el(
      'div',
      { class: 'painel rolagem' },
      el(
        'table',
        { class: 'comparar' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: 'Pessoa' }),
            c.dailies.map((d) => {
              const info = estado.dailies.find((x) => x.id === d.id);
              return el('th', {}, link('dias', { ids: d.id }, dataBr(d.data)), info ? el('span', { class: 'suave', text: `  ${hora(info.iniciadaEm)}` }) : null);
            }),
          ),
        ),
        el(
          'tbody',
          {},
          el('tr', {}, el('td', { class: 'suave', text: 'Resumo' }), c.dailies.map((d) => el('td', { class: 'suave', text: d.resumoGeral ?? '—' }))),
          c.linhas.map((l) =>
            el(
              'tr',
              {},
              el('td', {}, pessoaLinha(l.participante)),
              c.dailies.map((d) => el('td', {}, l.porDaily[d.id] ? blocoPessoa(l.porDaily[d.id], d.id) : el('span', { class: 'suave', text: '—' }))),
            ),
          ),
        ),
      ),
    ),
  ];
}

async function telaPessoa(id, q) {
  const ultima = estado.dailies.at(-1)?.data ?? hoje();
  const trintaAntes = new Date(new Date(`${ultima}T00:00:00Z`).getTime() - 30 * 864e5).toISOString().slice(0, 10);
  const de = q.get('de') || trintaAntes;
  const ate = q.get('ate') || ultima;
  const [pessoa, dias] = await Promise.all([
    api(`/participantes/${id}`),
    api(`/participantes/${id}/historico?${new URLSearchParams({ timeId: estado.timeId, de, ate })}`),
  ]);

  const campoDe = el('input', { type: 'date', value: de });
  const campoAte = el('input', { type: 'date', value: ate });
  return [
    el(
      'div',
      { class: 'pagina-topo' },
      el(
        'div',
        { class: 'perfil' },
        avatar(pessoa.nome, 'g'),
        el('div', {}, el('span', { class: 'sobretitulo', text: 'O que reportou nas dailies' }), el('h1', { text: pessoa.nome })),
      ),
    ),
    el(
      'form',
      { class: 'filtros', onsubmit: (e) => (e.preventDefault(), ir(`pessoa/${id}`, { de: campoDe.value, ate: campoAte.value })) },
      el('label', {}, 'De', campoDe),
      el('label', {}, 'Até', campoAte),
      el('button', { type: 'submit', text: 'Aplicar' }),
    ),
    dias.length
      ? el(
          'div',
          { class: 'linha-tempo' },
          dias
            .toReversed()
            .map((d) =>
              el(
                'article',
                { class: 'painel card' },
                el('div', { class: 'card-topo' }, el('h3', {}, link('dias', { ids: d.dailyId }, dataLonga(d.data)))),
                blocoPessoa(d, d.dailyId),
              ),
            ),
        )
      : vazio('calendario', 'Nenhuma daily com esta pessoa no período.'),
  ];
}

async function telaBloqueios(q) {
  const status = q.get('status') ?? 'ABERTO';
  const bloqueios = await api(`/bloqueios?${new URLSearchParams({ timeId: estado.timeId, ...(status !== 'TODOS' && { status }) })}`);
  const aba = (valor, texto) => el('button', { type: 'button', text: texto, 'aria-pressed': String(status === valor), onclick: () => ir('bloqueios', { status: valor }) });

  return [
    el(
      'div',
      { class: 'pagina-topo' },
      el(
        'div',
        {},
        el('span', { class: 'sobretitulo', text: timeAtual()?.nome ?? '' }),
        el('h1', { text: 'Bloqueios' }),
        el('div', { class: 'meta' }, el('span', { text: 'O que foi citado como bloqueio, desde quando e em quais dailies apareceu.' })),
      ),
    ),
    el('div', { class: 'segmentos', role: 'group', 'aria-label': 'Situação' }, aba('ABERTO', 'Em aberto'), aba('RESOLVIDO', 'Resolvidos'), aba('TODOS', 'Todos')),
    bloqueios.length
      ? el(
          'div',
          { class: 'lista' },
          bloqueios.map((b) =>
            el(
              'article',
              { class: `painel bloqueio-card${b.status === 'RESOLVIDO' ? ' resolvido' : ''}` },
              el('span', { class: 'simbolo' }, icone(b.status === 'RESOLVIDO' ? 'resolvido' : 'bloqueio')),
              el(
                'div',
                {},
                el('strong', { text: b.descricao }),
                el(
                  'div',
                  { class: 'nota' },
                  pessoaLinha(b.participante),
                  el('span', { text: `desde ${dataBr(b.desde)}` }),
                  b.ultimaMencao !== b.desde ? el('span', { text: `última menção em ${dataBr(b.ultimaMencao)}` }) : null,
                  el(
                    'span',
                    {},
                    'apareceu em ',
                    b.dailies.flatMap((id, i) => {
                      const d = estado.dailies.find((x) => x.id === id);
                      return [i ? ', ' : null, link('dias', { ids: id }, d ? `${diaMes(d.data)} ${hora(d.iniciadaEm)}` : `#${id}`)];
                    }),
                  ),
                ),
              ),
              b.status === 'RESOLVIDO'
                ? el('span', { class: 'etiqueta verde', text: `resolvido em ${diaMes(b.resolvidoEm)}` })
                : el('span', { class: 'etiqueta ambar', text: 'em aberto' }),
            ),
          ),
        )
      : vazio('resolvido', status === 'ABERTO' ? 'Nenhum bloqueio em aberto.' : 'Nenhum bloqueio encontrado.'),
  ];
}

/** Cartão de uma fala (resultado de busca ou citação de resposta): abre a transcrição naquele ponto. */
function cartaoFala({ dailyId, falaId, data, participante, inicioMs }, conteudo) {
  return el(
    'li',
    {},
    el(
      'button',
      { type: 'button', class: 'fala-card', title: 'Ver na transcrição', onclick: () => abrirTranscricao(dailyId, [falaId]) },
      avatar(participante.nome),
      el('span', { class: 'quem' }, participante.nome, el('small', { text: `${dataBr(data)} · ${tempo(inicioMs)}` })),
      el('p', {}, conteudo),
    ),
  );
}

async function telaBusca(q) {
  const termo = q.get('q') ?? '';
  const filtros = { participanteId: q.get('participanteId') ?? '', de: q.get('de') ?? '', ate: q.get('ate') ?? '' };
  const pessoas = await api(`/times/${estado.timeId}/participantes`);

  const campo = el('input', { type: 'search', value: termo, placeholder: 'Buscar por qualquer palavra dita nas dailies', 'aria-label': 'Buscar nas transcrições', autofocus: true });
  const quem = el('select', {}, el('option', { value: '', text: 'Todas as pessoas' }), pessoas.map((p) => el('option', { value: String(p.id), text: p.nome, selected: String(p.id) === filtros.participanteId })));
  const de = el('input', { type: 'date', value: filtros.de });
  const ate = el('input', { type: 'date', value: filtros.ate });
  const formulario = el(
    'form',
    { class: 'filtros', onsubmit: (e) => (e.preventDefault(), ir('busca', { q: campo.value.trim(), participanteId: quem.value, de: de.value, ate: ate.value })) },
    el('div', { class: 'campo-busca' }, icone('busca'), campo),
    el('label', {}, 'Pessoa', quem),
    el('label', {}, 'De', de),
    el('label', {}, 'Até', ate),
    el('button', { type: 'submit', class: 'primario', text: 'Buscar' }),
  );

  let resultado = vazio('busca', 'Digite um termo para procurar nas transcrições. A busca ignora acentos e maiúsculas.');
  if (termo.length === 1) resultado = vazio('busca', 'Digite pelo menos 2 caracteres.');
  if (termo.length >= 2) {
    const params = new URLSearchParams({ q: termo, timeId: estado.timeId });
    for (const [k, v] of Object.entries(filtros)) if (v) params.set(k, v);
    const achados = await api(`/busca?${params}`);
    resultado = achados.length
      ? [
          el('h2', {}, 'Resultados', el('span', { class: 'conta-itens', text: String(achados.length) })),
          el('ul', { class: 'resultados' }, achados.map((a) => cartaoFala(a, trechoMarcado(a.trecho)))),
        ]
      : vazio('busca', `Nada encontrado para "${termo}".`);
  }
  return [
    el('div', { class: 'pagina-topo' }, el('div', {}, el('span', { class: 'sobretitulo', text: timeAtual()?.nome ?? '' }), el('h1', { text: 'Busca nas transcrições' }))),
    formulario,
    resultado,
  ];
}

async function telaPerguntas() {
  const pessoas = await api(`/times/${estado.timeId}/participantes`);
  const ultima = estado.dailies.at(-1)?.data ?? hoje();
  const seteAntes = new Date(new Date(`${ultima}T00:00:00Z`).getTime() - 7 * 864e5).toISOString().slice(0, 10);

  const campo = el('textarea', { placeholder: 'Pergunte algo sobre as dailies do período…', 'aria-label': 'Pergunta', maxLength: 500, required: true });
  const quem = el('select', {}, el('option', { value: '', text: 'Todas as pessoas' }), pessoas.map((p) => el('option', { value: String(p.id), text: p.nome })));
  const de = el('input', { type: 'date', value: seteAntes });
  const ate = el('input', { type: 'date', value: ultima });
  const botao = el('button', { type: 'submit', class: 'primario empurra' }, icone('brilho'), 'Perguntar');
  const saida = el('div', {});

  async function perguntar(e) {
    e?.preventDefault();
    if (campo.value.trim().length < 5) return campo.focus();
    botao.disabled = true;
    saida.replaceChildren(el('p', { class: 'pensando', text: 'Lendo as transcrições do período…' }));
    try {
      const r = await api('/perguntas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pergunta: campo.value, timeId: estado.timeId, participanteId: quem.value || undefined, de: de.value || undefined, ate: ate.value || undefined }),
      });
      saida.replaceChildren(
        el('div', { class: 'painel resposta' }, el('span', { class: 'rotulo' }, icone('brilho'), 'Resposta'), r.resposta),
        r.citacoes.length ? el('h2', {}, 'Falas de origem', el('span', { class: 'conta-itens', text: String(r.citacoes.length) })) : null,
        r.citacoes.length ? el('ul', { class: 'resultados citacoes' }, r.citacoes.map((c) => cartaoFala(c, c.texto))) : null,
        r.modelo
          ? el('p', {
              class: 'dica',
              text:
                `${plural(r.dailiesConsideradas, 'daily lida', 'dailies lidas')} · ${r.modelo}` +
                (r.periodoCortado ? ' · O período era grande demais: só as dailies mais recentes foram lidas. Escolha um intervalo menor para cobrir tudo.' : ''),
            })
          : null,
      );
    } catch (erro) {
      saida.replaceChildren(el('div', { class: 'painel vazio erro' }, icone('bloqueio'), el('p', { text: erro.message })));
    } finally {
      botao.disabled = false;
    }
  }

  const sugestao = (texto) =>
    el('button', { type: 'button', text: texto, onclick: () => ((campo.value = texto), perguntar()) });

  return [
    el(
      'div',
      { class: 'pagina-topo' },
      el(
        'div',
        {},
        el('span', { class: 'sobretitulo', text: timeAtual()?.nome ?? '' }),
        el('h1', { text: 'Perguntas sobre um período' }),
        el('div', { class: 'meta' }, el('span', { text: 'A resposta usa só o que foi dito nas dailies e mostra as falas de origem.' })),
      ),
    ),
    el(
      'div',
      { class: 'sugestoes', 'aria-label': 'Sugestões de pergunta' },
      sugestao('O que ficou pendente?'),
      sugestao('Quais bloqueios continuam em aberto?'),
      sugestao('O que foi decidido?'),
      sugestao('O que cada pessoa reportou?'),
    ),
    el(
      'form',
      { class: 'painel pergunta', onsubmit: perguntar },
      campo,
      el('div', { class: 'filtros' }, el('label', {}, 'Pessoa', quem), el('label', {}, 'De', de), el('label', {}, 'Até', ate), botao),
    ),
    saida,
  ];
}

/** O trecho vem da API com <mark> e o resto escapado; aqui vira nós de texto + <mark>, sem innerHTML. */
function trechoMarcado(trecho) {
  const desfazer = (t) => t.replace(/&(amp|lt|gt|quot|#39);/g, (_, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[c]);
  return trecho.split(/(<mark>.*?<\/mark>)/).map((parte) => {
    const m = parte.match(/^<mark>(.*)<\/mark>$/);
    return m ? el('mark', { text: desfazer(m[1]) }) : desfazer(parte);
  });
}

/** Sem sessão: some com a navegação e mostra só o botão de entrar. */
function telaLogin() {
  estado.deslogado = true;
  clearTimeout(recarga);
  document.body.classList.add('deslogado');
  document.body.classList.remove('carregando');
  fecharGaveta();
  principal.replaceChildren(
    el(
      'div',
      { class: 'entrada' },
      el(
        'div',
        { class: 'painel' },
        el('img', { src: 'marca.svg', alt: '', width: 56, height: 56 }),
        el('h1', { text: 'BotMRX' }),
        el('p', { text: 'O resumo das dailies do seu time: o que cada pessoa fez, vai fazer e o que está bloqueando.' }),
        el('a', { class: 'botao', href: '/api/auth/entrar', text: 'Entrar com Discord' }),
        el('p', { class: 'dica', text: 'Acesso para gestores do time e administradores do servidor.' }),
      ),
    ),
  );
}

// ------------------------------------------------------------------ ciclo

async function carregarDailies() {
  estado.dailies = estado.timeId ? await api(`/dailies?timeId=${estado.timeId}`) : [];
}

let desenho = 0;
async function desenhar() {
  if (estado.deslogado) return;
  const { secao, partes, q } = rota();
  const meu = ++desenho;
  clearTimeout(recarga);
  fecharGaveta();
  for (const a of document.querySelectorAll('#nav a')) {
    const atual = a.dataset.secao === (secao === 'pessoa' ? 'dias' : secao);
    atual ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  }
  corpo.classList.toggle('sem-lateral', secao !== 'dias');
  document.body.classList.add('carregando');

  let conteudo;
  try {
    if (!estado.timeId) conteudo = [vazio('calendario', 'Nenhum time disponível para você ainda. O time é criado na primeira ', el('code', { text: '/daily iniciar' }), ' de um canal de voz.')];
    else if (secao === 'dias') conteudo = await telaDias(q);
    else if (secao === 'pessoa' && partes[0]) conteudo = await telaPessoa(Number(partes[0]), q);
    else if (secao === 'bloqueios') conteudo = await telaBloqueios(q);
    else if (secao === 'busca') conteudo = await telaBusca(q);
    else if (secao === 'perguntas') conteudo = await telaPerguntas();
    else conteudo = [vazio('vazio', 'Página não encontrada.')];
  } catch (e) {
    conteudo = [el('div', { class: 'painel vazio erro' }, icone('bloqueio'), el('p', { text: `Não foi possível carregar: ${e.message}` }))];
  }
  if (meu !== desenho || estado.deslogado) return; // já navegou para outra tela, ou a sessão acabou
  document.body.classList.remove('carregando');
  principal.replaceChildren(...conteudo.flat(3).filter(Boolean));
}

async function iniciar() {
  try {
    const eu = await api('/auth/eu');
    if (eu.login && !eu.usuario) return telaLogin();
    if (eu.usuario) {
      const sair = async () => {
        await fetch('/api/auth/sair', { method: 'POST' }).catch(() => {});
        location.reload();
      };
      conta.replaceChildren(
        avatar(eu.usuario.nome),
        el('span', { class: 'nome', text: eu.usuario.nome }),
        el('button', { type: 'button', class: 'so-icone', 'aria-label': 'Sair', title: 'Sair', onclick: sair }, icone('sair')),
      );
    }
    estado.times = await api('/times');
  } catch (e) {
    if (!estado.deslogado) principal.replaceChildren(el('div', { class: 'painel vazio erro' }, icone('bloqueio'), el('p', { text: `Não foi possível falar com a API: ${e.message}` })));
    return;
  }
  const salvo = Number(localStorage.getItem('botmrx.time'));
  estado.timeId = (estado.times.find((t) => t.id === salvo) ?? estado.times.find((t) => t.dailies > 0) ?? estado.times[0])?.id ?? null;
  seletorTime.replaceChildren(...estado.times.map((t) => el('option', { value: String(t.id), text: t.nome, selected: t.id === estado.timeId })));
  seletorTime.hidden = estado.times.length < 2;
  seletorTime.addEventListener('change', async () => {
    estado.timeId = Number(seletorTime.value);
    estado.mes = null;
    localStorage.setItem('botmrx.time', String(estado.timeId));
    await carregarDailies().catch(() => {});
    location.hash === '#/dias' ? desenhar() : ir('dias');
  });

  await carregarDailies();
  window.addEventListener('hashchange', desenhar);
  fundoGaveta.addEventListener('click', fecharGaveta);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !gaveta.hidden && fecharGaveta());
  await desenhar();
}

await iniciar();
