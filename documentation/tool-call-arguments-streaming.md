# Outils du reviewer : accumulation des arguments d'appel

## Contexte

| # | Question | Reponse |
|---|----------|---------|
| QUOI | Le flux de `tool_calls` entre `OpenAIProvider` et l'API DeepSeek, en streaming SSE | |
| OU | `apps/desktop/electron/reviewer/providers/openai.ts` | |
| QUAND | Regression decouverte en production sur la version 0.12.0, confirmee a l'aide d'un repro au niveau du fil | |
| EFFET | Les arguments d'appel arrivent corrompus (`_raw: "2}"`), l'agent ne peut plus appeler aucun outil | |

## 1. Le mecanisme de corruption

### 1.1 QUOI

Le fournisseur DeepSeek decoupe les `arguments` d'un appel d'outil en fragments delimites par les frontieres de tokens. Chaque evenement SSE transporte un fragment distinct.

### 1.2 COMMENT

La version 0.12.0 a remplace l'accumulation par concatenation simple par une regle de remplacement :

| Version | Logique |
|---------|---------|
| 0.11.8 | `cur.args += raw.function.arguments` — concatenation pure |
| 0.12.0 | `isJson(combined) ? combined : isJson(frag) ? frag : combined` — remplacement |
| 0.12.1 | concatenation pure + repli post-hoc dans `parseArgs` |

La regle de 0.12.0 devait tolerer les fournisseurs qui renvoient la totalite du payload a chaque delta. Elle produit un effet destructeur sur les flux de fragments : un fragment qui est seul un JSON valide (`2`, `20`, `true`, `false`, `"agent-1"`) remplace le prefixe deja accumule.

### 1.3 EFFET

Correspondance entre les appels voulus et les arguments recus en production :

| Appel voulu | Fragments sur le fil | Accumule | `_raw` observe |
|-------------|----------------------|----------|----------------|
| `{"path": "frontend/src", "depth": 2}` | `...`, `"depth": `, `2`, `}` | `2}` | `2}` |
| `{"agentId": "agent-1"}` | `...`, `"agent-`, `1`, `"}` | `1"}` | `1"}` |
| `{"pattern": "...", "maxMatches": 100}` | `...`, `100`, `}` | `100}` | `100}` |
| `subGoals` avec `done: false` | `...`, `false`, `}]}` | `false}]}` | ` false}]}` |

Les appels sans fragment autonome valide (un seul parametre, ou decoupage quelconque) fonctionnaient : `{"path":"frontend"}`, `{"cwd":...,"kind":...}`, `{"paths":[...]}`.

> **Repli en boucle.** Une fois corrompus, les arguments `_raw` sont reserialises dans l'historique avec `JSON.stringify` : chaque retentative du modele re-echappe la forme precedente (`1"}` puis `1\"}` puis `1\\\"}`), l'echappement doublant a chaque cycle. La boucle de retry devient auto-entretenue.

### 1.4 Preuve au niveau du fil

Capture du fil `api.deepseek.com` (modele `deepseek-v4-flash`, `max_tokens: 4096`, `reasoning_effort: medium`) pour `{"path": "frontend/src", "depth": 2}` :

```
tc[0] frag: "{"    tc[0] frag: "path"    tc[0] frag: ": "
tc[0] frag: "front"  tc[0] frag: "end"   tc[0] frag: "/src"
tc[0] frag: "depth" tc[0] frag: ": "     tc[0] frag: "2"
tc[0] frag: "}"
```

| Logique | Resultat |
|---------|----------|
| 0.11.8 (concatenation) | `{"path": "frontend/src", "depth": 2}` — parse OK |
| 0.12.0 (remplacement) | `2}` — `_raw` |
| 0.12.1 (concatenation + repli) | `{"path": "frontend/src", "depth": 2}` — parse OK |

## 2. Le correctif

### 2.1 QUOI

Supprimer la regle de remplacement par delta et appliquer la tolerance au re-envoi complet apres la fin du flux.

### 2.2 COMMENT

Dans `OpenAIProvider.complete` :

| Etape | Avant (0.12.0) | Apres (0.12.1) |
|-------|----------------|----------------|
| Accumulation | `cur.args = isJson(combined) ? combined : isJson(frag) ? frag : combined` | `cur.lastFrag = frag; cur.args += frag` |
| Analyse | `parseArgs(c.args)` | `parseArgs(c.args, c.lastFrag)` |

`parseArgs(raw, lastFrag)` : tente `JSON.parse(raw)` ; en cas d'echec, tente `JSON.parse(lastFrag)` si le dernier fragment est complet et different du tout ; sinon renvoie `{ _raw: raw }`.

Le repli ne se declenche que lorsqu'un fournisseur renvoie vraiment le payload complet a chaque delta (le tout accumule `{a}{a}` ne parse pas, le dernier fragment parse). Un flux de fragments authentique ne le declenche jamais : le tout parse.

### 2.3 EFFET

- DeepSeek : arguments complets, aucun `_raw`.
- Fournisseurs a re-envoi complet : toujours supportes (repli post-hoc).
- Corruption veritable du flux : toujours signalee par `_raw`, jamais silencieusement corrigee.

## 3. Le correctif du fork (erreur au lancement d'auto compose)

| Element | Valeur |
|---------|--------|
| QUOI | La copie recursive de `forkProject` abandonnait sur un fichier illisible |
| OU | `apps/desktop/electron/fork.ts` |
| EFFET | L'erreur `fork failed: EACCES... copyfile permission denied... local-gpu` bloquait le lancement d'auto compose et laissait un fork partiel |

La copie est maintenant de type best-effort : les entrees illisibles (`EACCES`, `EPERM`), les liens casses (`ENOENT`) et les types speciaux (fifo, socket) sont ignores ; un sous-repertoire illisible est saute entierement ; tout echec net supprime le fork partiel.

| Cas | Avant | Apres |
|-----|-------|-------|
| Fichier illisible dans `local-gpu/` | `fork failed: EACCES` | ignore, fork OK |
| Sous-repertoire illisible | `fork failed: EACCES` | sous-arbre ignore |
| Lien symbolique casse | `fork failed: ENOENT` | ignore |
| Fifo | blocage potentiel de `copyFile` | jamais copie |
| Echec dur (mkdir impossible) | fork partiel laisse sur disque | fork partiel supprime |

## 4. Verification

| Verification | Resultat |
|--------------|----------|
| Repro fil reel (cle API) — logique 0.12.0 | `_raw: "2}"`, `_raw: "20}"` — corruption reproduite |
| Repro fil reel (cle API) — logique 0.12.1 | arguments complets sur 2 appels |
| Tests unitaires `providers.test.ts` | 27 tests, dont 5 nouveaux (fragments autonomes, multi-appels, re-envoi complet, `_raw` veritable) |
| Tests unitaires `fork.test.ts` | 9 tests, dont 4 nouveaux (EACCES, sous-repertoire, lien casse, echec dur) |
| Suite complete | 560 tests passes |
| Driver E2E | `DRIVER-E2E OK` |

## 5. Limites et evolution

Le repli post-hoc ne detecte pas le re-envoi complet si le dernier fragment est lui-meme tronque : ce cas retombe sur `_raw`, ce qui est correct. Une journalisation durable des `arguments` bruts (fichiers de log cotes main process) rendrait la prochaine corruption de flux directement inspectable sans repro fil.
