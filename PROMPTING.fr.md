# Notes sur le prompting

[English](PROMPTING.en.md)

Voici un résumé des techniques de prompting pour l’auto-complétion de code intégrée, fondé sur des implémentations open source (Continue.dev, Sourcegraph Cody, Tabby, GitHub Copilot), la documentation des modèles (DeepSeek, Qwen, CodeLlama, StarCoder, Codestral) et la recherche récente sur le Fill-in-the-Middle. Considère-le comme un retour d’expérience, sans la partie où on perd une fin de semaine à cause d’un jeton invisible.

---

## Fill-in-the-Middle (FIM)

L’auto-complétion classique fonctionne de gauche à droite. Le modèle voit tout ce qui précède le curseur et devine la suite. Le FIM renverse la logique en fournissant au modèle le code _avant_ et _après_ le curseur, puis en lui demandant de combler le vide. L’idée est simple, mais la différence en pratique est considérable. Le modèle ne sait pas seulement d’où vient le code, il sait aussi où il doit atterrir. C’est comme la différence entre terminer la phrase de quelqu’un quand on n’a entendu que le début, et remplir un blanc quand on peut lire la phrase entière. Mêmes mots, probabilités de réussite très différentes.

### Deux façons d’ordonner le prompt : PSM et SPM

Voici l’enjeu central. On a trois morceaux (prefix, suffix, middle), mais le modèle génère toujours les jetons de gauche à droite. Il y a deux façons de les arranger, que la communauté n’a bien sûr pas pu s’empêcher de baptiser avec des sigles à trois lettres.

La réponse intuitive est PSM (Prefix-Suffix-Middle) : le préfixe d’abord, puis le suffixe, puis le modèle remplit le milieu :

```
[PREFIX_TOKEN] prefix [SUFFIX_TOKEN] suffix [MIDDLE_TOKEN] → le modèle génère ici
```

C’est ce que la plupart des serveurs d’inférence (dont Ollama) implémentent, et ce que tu vas rencontrer dans les API courantes.

La réponse astucieuse est SPM (Suffix-Prefix-Middle) : le suffixe d’abord, _puis_ le préfixe, puis le modèle continue :

```
[SUFFIX_TOKEN] suffix [PREFIX_TOKEN] prefix [MIDDLE_TOKEN] → le modèle génère ici
```

Si le suffixe vient en premier, c’est que le préfixe et le milieu généré se retrouvent côte à côte. Pas de saut maladroit ; le modèle continue à écrire depuis le préfixe — ce que les modèles autorégressifs font le mieux. En prime, SPM s’accorde mieux avec le cache KV,[^19] puisque l’ajout de jetons au préfixe n’invalide pas le calcul mis en cache pour le suffixe.

Et ça marche. [L’article fondateur sur le FIM](https://arxiv.org/abs/2207.14255) a montré que SPM surpasse PSM sur les trois types de benchmarks (complétion mono-ligne, multi-ligne et span aléatoire) et à toutes les échelles de modèles. [Les évaluations de CodeLlama](https://arxiv.org/abs/2308.12950) montrent que SPM gagne de 2 à 6 points sur la complétion mono-ligne (Tableau 6), bien que PSM reprenne l’avantage sur l’infilling de spans aléatoires lorsque le token healing n’est pas implémenté (Section 3.2). La tendance générale favorise SPM pour les types de complétions qui comptent le plus en auto-complétion.

Cela dit, la plupart des modèles sont entraînés sur les deux. [CodeLlama](https://arxiv.org/abs/2308.12950) applique le FIM à 90 % de ses données d’entraînement et répartit cela à parts égales entre PSM et SPM (Section 2.3), avec de bons résultats dans les deux cas. [L’article fondateur](https://arxiv.org/abs/2207.14255) a constaté qu’en appliquant la transformation FIM à environ 50–90 % des données d’entraînement, on obtient un bon infilling sans nuire à la génération gauche-droite classique, donc il n’y a pas vraiment de compromis. La diplomatie l’emporte.

### Formats de jetons par modèle

Chaque famille de modèles a ses propres jetons sentinelles. Les différences paraissent mineures — d’où le danger. En cas d’erreur, le modèle traite les jetons comme du texte littéral plutôt que comme des marqueurs structurels sans se plaindre.[^18] Voici l’aide-mémoire :

| Modèle                         | Token prefix        | Token suffix        | Token middle        | Notes                                                                      |
| ------------------------------ | ------------------- | ------------------- | ------------------- | -------------------------------------------------------------------------- |
| **Qwen2.5-Coder**[^13]         | `<\|fim_prefix\|>`  | `<\|fim_suffix\|>`  | `<\|fim_middle\|>`  | Supporte aussi le multi-fichier avec `<\|repo_name\|>` et `<\|file_sep\|>` |
| **StarCoder / StarCoder2**[^6] | `<fim_prefix>`      | `<fim_suffix>`      | `<fim_middle>`      | Pas de pipes. StarCoder2-3b/7b recommandé plutôt que le 15b pour le FIM    |
| **CodeLlama**[^7]              | `<PRE>` (id 32007)  | `<SUF>` (id 32008)  | `<MID>` (id 32009)  | Aussi `<EOT>` (id 32010). Supporte le flag `suffix_first` pour SPM         |
| **DeepSeek Coder**[^8]         | `<｜fim▁begin｜>`   | `<｜fim▁hole｜>`    | `<｜fim▁end｜>`     | Caractères pleine chasse. API nécessite `base_url=.../beta`. Max 4K jetons |
| **Codestral (Mistral)**[^9]    | Géré par le serveur | Géré par le serveur | Géré par le serveur | Utilise les champs `prompt` + `suffix`. Endpoint `/fim` dédié              |
| **Stable Code**[^10]           | `<fim_prefix>`      | `<fim_suffix>`      | `<fim_middle>`      | Même format que StarCoder                                                  |
| **CodeGeeX**[^11]              | `<\|code_prefix\|>` | `<\|code_suffix\|>` | `<\|code_middle\|>` | Ordre SPM. Encadré par les jetons `<\|user\|>` / `<\|assistant\|>`         |

Quelques pièges attendent les imprudents. StarCoder utilise `<fim_prefix>` sans pipes, tandis que Qwen utilise `<|fim_prefix|>` avec. Facile à confondre, et le modèle ne te préviendra pas. DeepSeek est le plus sournois. Il utilise des caractères Unicode en pleine largeur[^17] (`｜` U+FF5C et `▁` U+2581), pas leurs sosies ASCII. Demande-moi pas combien de temps ça m’a pris.

### Exemples de templates tirés de Continue.dev

Continue.dev fournit des templates FIM pour les principaux modèles dans [`AutocompleteTemplate.ts`](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts), ce qui t’épargne l’archéologie caractère par caractère décrite plus haut. Voici les chaînes de prompt (avec interpolation `${variable}`) :

**[StarCoder2](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts#L244) :**

```
${otherFiles}<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>
```

**[CodeLlama](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts#L277) :**

```
<PRE> ${prefix} <SUF>${suffix} <MID>
```

**[DeepSeek](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts#L283) :**

```
<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>
```

**[Qwen (multi-fichier)](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts#L56) :**

```
<|repo_name|>${reponame}
${fileContents}
<|file_sep|>${currentFilePath}
<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>
```

**Codestral (multi-fichier) :** Le [template Codestral](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts) de Continue intègre le contexte des fichiers référencés au prompt en ajoutant les chemins complets avant les jetons `[SUFFIX]` et `[PREFIX]`.

### Le FIM géré par le serveur ou l’insertion manuelle des jetons

Il y a deux façons d’intégrer les jetons FIM dans un prompt, et le choix se résume à ta tolérance au gossage évitable.

Le plus simple, c’est le FIM géré par le serveur. Ollama le supporte nativement. On envoie `prompt` et `suffix` comme champs JSON séparés dans la requête `/api/generate`, et le serveur les encadre avec le bon template FIM pour le modèle chargé. Pas besoin de connaître les jetons attendus ; le serveur s’en occupe. C’est un peu comme utiliser un ORM : moins de contrôle, moins de mystères à 2 h du matin. Un bémol : Ollama détermine si un modèle supporte le FIM en vérifiant si son template Modelfile contient `{{.Suffix}}`. Certains modèles de base entraînés au FIM (comme qwen2.5-coder base) se font [rejeter à tort](https://github.com/ollama/ollama/issues/7052) parce que leur template livré omet ce marqueur, alors que la variante instruct du même modèle fonctionne sans problème.

Attention cependant. Le moteur de templates Go d’Ollama [considère une chaîne vide comme évaluée à faux](https://github.com/ollama/ollama/issues/6932) pour le champ suffix. Si tu envoies `"suffix": ""`, Ollama saute silencieusement le formatage FIM et revient au mode chat classique. Tu vas obtenir des complétions, elles seront juste moins bonnes, et tu vas passer une heure à chercher pourquoi. La solution est toute bête. Envoie une chaîne non vide comme `" "` au lieu de `""`.

L’alternative est l’insertion manuelle des jetons, où tu construis le prompt complet toi-même, quelque chose comme `PREFIX_TOKEN + preamble + prefix + SUFFIX_TOKEN + suffix + MIDDLE_TOKEN`. Plus de travail, mais nécessaire quand le serveur ne gère pas le FIM nativement. L’inconvénient est de maintenir une logique de template par modèle dans ton code client, autant dire un bonheur.

---

## Collecte de contexte

La qualité d’une complétion dépend autant du _contexte envoyé_ que du modèle utilisé. On peut passer la journée à comparer les modèles : envoyer le mauvais contexte au bon modèle produira quand même n’importe quoi, très sûr de lui. Toutes les principales extensions d’auto-complétion misent gros sur la sélection du contexte, et elles convergent vers une boîte à outils commune.

### Les signaux que tout le monde utilise

Le signal le plus évident est le préfixe et le suffixe du fichier courant. Chaque extension inclut le code avant et après le curseur, le préfixe ayant la priorité. La question porte sur les proportions, et Continue [alloue par défaut](https://github.com/continuedev/continue/blob/de12be19ce81f0ee17f950c1ee5b6b00f70ec5bf/core/util/parameters.ts) 30 % du budget de jetons au préfixe et 20 % au suffixe.

Le levier le plus rentable de toute la chaîne, cependant, c’est le chemin du fichier et l’identifiant de langage. Un commentaire `// Path: src/utils/parser.ts` coûte une poignée de jetons et donne au modèle un indice fort sur le rôle du module. [La recherche sur la composition de contexte](https://arxiv.org/abs/2402.09230) a confirmé qu’en structurant cela en `extension_fichier + séparateur_langage + chemin_fichier + séparateur_métadonnées + code`, on améliore la qualité de manière mesurable. Quelques jetons de métadonnées plus utiles que des paragraphes entiers de contexte de code.
La couche de contexte suivante vient des onglets ouverts dans l’éditeur. Copilot[^12] et Cody regardent tous deux les fichiers actuellement ouverts, et Continue considère automatiquement les fichiers récemment ouverts ou modifiés. Si un fichier est ouvert, c’est probablement qu’on travaille dessus. (Ou qu’on l’a ouvert il y a trois jours sans le refermer, mais en moyenne l’heuristique tient.) Continue pousse plus loin avec son [`RecentlyEditedTracker`](https://github.com/continuedev/continue/blob/de12be19ce81f0ee17f950c1ee5b6b00f70ec5bf/extensions/vscode/src/autocomplete/recentlyEdited.ts), conçu pour conserver jusqu’à 3 plages d’édition récentes par fichier avec une fenêtre d’obsolescence de 2 minutes. Ainsi, si tu viens de modifier `formatDate`, les complétions dans un fichier qui l’appelle capteront ces changements.

Il y a toujours trop d’imports pour tout inclure en bloc, donc Continue utilise la [correspondance par symboles importés](https://docs.continue.dev/ide-extensions/autocomplete/context-selection). Il examine les symboles proches du curseur, détermine lesquels correspondent à des imports, et récupère leurs définitions. Astucieux et peu coûteux — nos deux adjectifs préférés pour les décisions d’ingénierie.

L’un des signaux les plus puissants est la navigation vers la définition via le LSP. Continue utilise le Language Server Protocol exactement comme un développeur utilise ⌘-clic. Quand tu tapes un appel de fonction, il récupère la définition. Quand tu es dans le corps d’une méthode, il attrape les définitions de types des paramètres et du type de retour. C’est le genre de contexte qui transforme une complétion médiocre en une complétion excellente.

La signature de Continue est le [root path context](https://web.archive.org/web/20251118163602/https://blog.continue.dev/root-path-context-the-secret-ingredient-in-continues-autocomplete-prompt/). Au lieu d’indexer tout le dépôt, il remonte l’arbre syntaxique depuis le nœud courant jusqu’à la racine. Cela lui permet de « sembler comprendre l’intégralité du code en n’en lisant qu’une fraction ». Ce contexte se prête aussi au cache, puisque le même chemin racine donne le même contexte quel que soit l’endroit du curseur dans un sous-arbre. Cody et Tabby utilisent tree-sitter dans un but connexe mais différent. Cody [l’utilise pour déterminer l’_intention_](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion) du développeur : remplit-il le corps d’une fonction, écrit-il une docstring ou implémente-t-il un appel de méthode ? Des intentions différentes mènent à des stratégies de contexte distinctes. Tabby l’utilise davantage pour découper le code en tags structurés.

Et puis il y a l’artillerie lourde, le RAG au niveau du dépôt. [Tabby](https://deepwiki.com/TabbyML/tabby/3.2-code-completion-service) effectue une double recherche, en combinant la recherche sémantique par embeddings et la recherche par mots-clés BM25, fusionnées par Reciprocal Rank Fusion. Efficace, mais cela nécessite une infrastructure d’indexation que tout le monde n’a pas envie de mettre en place. Parfois on veut juste de l’auto-complétion, pas un doctorat accidentel en systèmes de recherche d’information.

### Comment les extensions trient le contexte

Avec un budget de jetons limité, il faut faire des choix. Voici comment les principaux outils décident ce qui reste et ce qui saute.

[Tabby](https://deepwiki.com/TabbyML/tabby/3.2-code-completion-service) fixe une longueur de prompt maximale par modèle et remplit par ordre de priorité, préfixe/suffixe d’abord puis les meilleurs snippets récupérés. Quand l’espace manque, les snippets les moins pertinents sautent. Dernier arrivé, premier viré, exactement comme le plan de recrutement de ta startup. Cody adopte une approche différente, [optimisant la vitesse plutôt que la couverture](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion). Pour l’auto-complétion (par opposition au chat), il privilégie le contexte local, avec tree-sitter qui évalue l’intention en continu pendant la frappe. Copilot prétraite le code environnant, y mêle des informations des onglets ouverts, et emballe le tout dans un seul prompt.[^12]

Continue est le plus transparent sur sa gestion du budget. Les [valeurs par défaut](https://github.com/continuedev/continue/blob/de12be19ce81f0ee17f950c1ee5b6b00f70ec5bf/core/util/parameters.ts) sont révélatrices :

- `maxPromptTokens` : 1024
- `prefixPercentage` : 0.3 (30 % pour le préfixe)
- `maxSuffixPercentage` : 0.2 (20 % pour le suffixe)
- Les ~50 % restants vont au contexte d’autres fichiers, aux définitions et aux snippets

Cette répartition 30/20/50 est le fruit de nombreuses expérimentations. C’est un bon point de départ si tu construis ton propre système.

### Trop de contexte nuit

Les expériences de Sourcegraph le confirment : [« l’ajout de contexte non pertinent peut dégrader la qualité des réponses »](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion). Tout jeter dans le prompt, côté contexte, c’est comme partir avec tout son linge pour une fin de semaine. Possible en théorie, guère utile.

Cela dit, un contexte _pertinent_ fait une vraie différence. [Une étude](https://arxiv.org/abs/2402.09230) a montré qu’en augmentant le contexte maximum de 384 à 1536 jetons (en passant d’un modèle GPT à LLaMA), la qualité des complétions s’améliore de 40 %, quasiment sans coût de latence. Par ailleurs, [la recherche sur le fine-tuning FIM par curriculum](https://arxiv.org/abs/2412.16589) a montré que les petits modèles bénéficient davantage d’un meilleur entraînement. Un modèle 1B gagne 6,25 % là où un 7B ne gagne que 1,25 %. La tendance se confirme. Un petit modèle est plus facilement désorienté par l’ambiguïté, et un meilleur contexte ou entraînement lève l’ambiguïté. C’est comme donner des indications de route à un touriste plutôt qu’à quelqu’un du coin. Le touriste a besoin de beaucoup plus de détails.

---

## Complétion par chat (le repli non-FIM)

Tous les modèles ne parlent pas FIM. Quand on est coincé avec un modèle de chat généraliste (GPT-4, Claude, Llama-chat, etc.), il faut présenter la complétion comme une conversation. Ça marche (plus ou moins) mais ça demande du doigté. C’est un peu comme demander à un conférencier de juste finir ta phrase. Il _peut_ le faire, mais tous ses réflexes jouent contre toi.

### Le prompt système

Le prompt système a deux missions : dire au modèle qu’il est un moteur de complétion de code, et interdire tout le reste aussi agressivement que possible. Voici la formulation retenue :

```txt
You are a code completion engine. Continue the code from where the prefix ends.
Output ONLY the raw code to insert. NEVER output explanations, comments about
the code, conversational text, or markdown. Do not repeat existing code. Match
the indentation and style. If unsure, output nothing.
```

Chaque mot de ce prompt compte. En retirer un seul et le modèle se rappelle aussitôt qu’il a été entraîné à être bavard.

Le qualifier de « code completion engine » plutôt que de « helpful assistant » donne le ton pour la suite. Ces modèles ont été RLHFisés jusqu’à la moelle pour être serviables et sympathiques, donc il faut être très ferme. Il faut aussi interdire tout ce qu’on ne veut pas. Markdown, explications, remplissage conversationnel. Si tu ne l’interdis pas, le modèle te le fournira avec plaisir. « Here’s the code you asked for! » gazouille-t-il, en emballant ta complétion d’une ligne dans une dissertation de trois paragraphes.

Le respect de l’indentation et du style compte plus qu’on ne le croit. Sans ça, les modèles imposent leurs propres préférences de formatage, ce qui jure pas mal dans le code de quelqu’un d’autre. Et « if unsure, output nothing » empêche les complétions hallucinées. Mieux vaut ne rien afficher que d’afficher du code faux.

La plupart des implémentations d’auto-complétion gardent la température basse (Continue utilise une valeur proche de zéro par défaut). La créativité, c’est très bien pour la poésie ; pour l’auto-complétion, on veut du prévisible, du correct, et terminé avant de perdre le fil.

### Structure du message utilisateur

Présente le code avec des délimiteurs clairs pour que le modèle sache exactement où insérer :

```xml
<file path="src/index.ts" language="typescript">
<related_context>
--- utils.ts ---
export function helper() { ... }
</related_context>
<prefix>import { helper } from './utils';

function main() {
  const result = </prefix>
<suffix>
  console.log(result);
}</suffix>
</file>
```

### Les pièges

Tu vas rencontrer ces problèmes. Tout le monde y passe.

Le principal problème, c’est le formatage en blocs Markdown. Les modèles de chat sont entraînés à mettre le code dans des blocs de code délimités (` ```lang ... ``` `), et ils le feront même quand tu leur dis explicitement de ne pas le faire. Le prompt système est visiblement plus une suggestion qu’un ordre. Il faut du post-traitement pour retirer la clôture ouvrante et tronquer à la fermante. Les préambules explicatifs du genre « Here’s the completion: » reviennent constamment, eux aussi. Certains modèles ne peuvent pas s’empêcher d’être serviables. C’est comme dire à un golden de pas rapporter la balle. Les modèles adorent aussi répéter le préfixe : ils recopient les dernières lignes de code que tu leur as données avant de produire la complétion réelle, d’où le « Do not repeat existing code » dans le prompt système.

Le vrai problème, cependant, est plus fondamental. Les modèles de chat généralistes ne sont tout simplement pas conçus pour ça. La documentation de Continue est d’une honnêteté rafraîchissante à ce sujet : [« Les modèles de chat, bien que plus grands, auront souvent de mauvais résultats même avec un prompting élaboré. »](https://github.com/continuedev/continue/blob/32d7ba280f4cbb0052d9d07786865c8ebebea8f1/docs/customize/model-roles/autocomplete.mdx) En pratique, un petit modèle entraîné au FIM surpassera le plus souvent un modèle de chat bien plus grand en auto-complétion. La voie chat est un repli de compatibilité, pas la voie nominale, et encore moins la voie rapide.

---

## Techniques FIM avancées

Celles-ci viennent de la recherche récente et nécessitent, pour la plupart, des ajustements côté entraînement. Mais ça aide à orienter la conception des prompts et du post-traitement, même sans entraîner son propre modèle. (Et si tu entraînes ton propre modèle, pense peut-être à une carrière en thérapie — au moins tes clients vont pouvoir te dire ce qui ne va pas.)

### Horizon-Length Prediction (HLP)

L’entraînement FIM standard utilise la prédiction du prochain jeton, où le modèle apprend à prédire chaque jeton à partir des précédents.[^1] Le problème, c’est que ça n’enseigne pas au modèle à _anticiper_. Quand la section du milieu est longue, le modèle commence à écrire sans savoir combien de place il lui reste avant le suffixe. C’est comme commencer une histoire sans savoir qu’il ne reste que deux paragraphes avant le mot « Fin ».

[HLP](https://arxiv.org/abs/2410.03103) ajoute un second objectif astucieux. À chaque étape, le modèle prédit aussi la fraction de la section du milieu restant à écrire — une valeur normalisée `(M-t)/M` qui décroît de 1 vers 0 au fil de la génération.[^1] C’est comme donner au modèle une barre de progression au lieu de le faire écrire à l’aveugle. Le gain est impressionnant. Jusqu’à 24 % d’amélioration relative[^1] sur les benchmarks FIM au niveau du dépôt, avec des gains sur les tâches par fichier aussi. Le raisonnement sur le code s’améliore au passage (jusqu’à 6 % sur CRUXEval).[^1] Et ça ne coûte presque rien. La tête de prédiction ajoutée représente moins de 0,01 % des paramètres du modèle et est retirée au moment de l’inférence, donc zéro coût à l’exécution.[^1] C’est l’une de ces rares améliorations sans contrepartie. On n’en a pas souvent, autant en profiter.

### FIM guidé par l’AST (AST-FIM)

L’entraînement FIM standard masque des spans de caractères aléatoires,[^2] ce qui coupe souvent le code à des endroits maladroits. Au milieu d’une expression, à mi-chemin d’un nom de variable, ce genre de choses. C’est comme apprendre à faire des puzzles dont quelqu’un a découpé les pièces aux ciseaux au lieu d’un emporte-pièce. [AST-FIM](https://arxiv.org/abs/2506.00204) est plus malin. Il masque des sous-arbres complets de l’arbre syntaxique abstrait.[^2] Une définition de fonction entière. Une expression complète. Un bloc if en entier.

Cela correspond à la façon dont les développeurs écrivent du code en vrai — « les modifications de code en conditions réelles impliquent souvent des unités syntaxiques complètes ».[^2] On n’insère pas des caractères au hasard ; on écrit le corps d’une fonction, on ajoute un argument, on remplit un appel de méthode. L’entraînement sur ces unités naturelles aide. AST-FIM bat le FIM aléatoire de jusqu’à 5 points sur les benchmarks SAFIM.[^2]

### Post-traitement guidé par la syntaxe

On peut améliorer les complétions _sans toucher au modèle_ en les tronquant aux limites syntaxiquement valides. La troncature basée sur l’AST réduit les erreurs de compilation sans coût GPU. Des améliorations qui ne coûtent rien — on ne va pas se plaindre.

Cody de Sourcegraph [fait ça en production](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion) avec tree-sitter :

- Si la première ligne d’une complétion ouvre un nouveau bloc (corps de fonction, branche if), Cody laisse le modèle continuer au lieu de couper à une ligne.
- Les complétions multi-lignes sont tronquées aux limites syntaxiquement complètes.
- Quand une complétion partage une ligne avec le suffixe, la correspondance de parenthèses empêche la duplication des fermantes.

C’est sans doute l’amélioration la plus simple à implémenter pour un système d’auto-complétion existant. Si tu ne retiens qu’une seule chose de cette section, que ce soit celle-ci.

### FIM guidé par instruction (IFIM)

[IFIM](https://arxiv.org/abs/2509.24637) ajoute une instruction en langage naturel au prompt FIM, qui décrit ce que le développeur a l’intention de faire. Quand le contexte du code est ambigu — compatible avec plusieurs complétions valides — l’instruction tranche. Cela améliore la précision de détection de l’intention de 9 points de pourcentage sans dégrader les performances FIM de base.

Le hic, c’est qu’il faut un moyen de déduire ou d’obtenir l’intention du développeur, ce qui n’est pas toujours évident. Les développeurs ne sont pas réputés pour articuler ce qu’ils veulent avant de l’écrire. (Voir aussi : l’intégralité des tickets Jira depuis l’invention de Jira.)

### Contexte FIM multi-fichier

Les prompts FIM basiques n’incluent que le fichier courant, mais les modèles modernes prennent en compte un contexte multi-fichier, ce qui aide beaucoup pour les références inter-fichiers. Le template multi-fichier de Qwen est le plus explicite :

```
<|repo_name|>${reponame}
<|file_sep|>path/to/file1.ts
[contenu de file1]
<|file_sep|>path/to/file2.ts
[contenu de file2]
<|file_sep|>path/to/current_file.ts
<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>
```

Le [template Codestral](https://github.com/continuedev/continue/blob/main/core/autocomplete/templating/AutocompleteTemplate.ts) de Continue fait quelque chose d’analogue avec les jetons `[SUFFIX]` / `[PREFIX]`.

Les premières approches du contexte multi-fichier étaient plus artisanales. Les méthodes modernes organisent les fichiers par dépendance ou pertinence plutôt que de les inclure au hasard, ce qui (sans surprise) fonctionne bien mieux que « voici des fichiers, bonne chance ».

---

## Jetons d’arrêt et terminaison de complétion

Lancer la génération, c’est facile. L’arrêter _au bon endroit_, c’est là que ça déraille. En auto-complétion, c’est comme savoir quand se taire dans un party.

### Jetons d’arrêt par modèle

Chaque modèle FIM a besoin de ses propres jetons d’arrêt. Sans eux, le modèle génère joyeusement au-delà de la limite de complétion, reproduit le suffixe, ou se lance dans du code qui n’a rien à voir. C’est comme un invité qui raconte encore une anecdote alors que l’hôte a déjà commencé à ramasser.

StarCoder et Stable Code utilisent `<fim_prefix>`, `<fim_suffix>`, `<fim_middle>` et `<|endoftext|>`. Qwen utilise les mêmes noms mais avec des pipes : `<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`, `<|endoftext|>`. CodeLlama n’a que `<EOT>` (token id 32010). Beaucoup d’extensions ajoutent aussi `\n\n` (double saut de ligne) comme séquence d’arrêt pratique pour les complétions mono-ligne.

### Bizarreries de `max_tokens`

`max_tokens` interagit avec la qualité des complétions de façon parfois inattendue. Sans cette limite, les modèles se terminent souvent proprement d’eux-mêmes. Avec une limite définie, ils génèrent parfois du remplissage répétitif juste pour épuiser le budget. (Les modèles, comme les consultants.) Codestral propose un paramètre `min_tokens` pour le problème inverse. Les modèles FIM ne produisent parfois aucun jeton quand le suffixe est proche du préfixe et que le modèle ne sait pas quoi mettre entre les deux. `min_tokens` l’incite à au moins essayer.

Garde un œil sur `finish_reason` dans la réponse : `"stop"` signifie qu’un jeton d’arrêt a été atteint (bien), `"length"` signifie que `max_tokens` a été atteint et que la sortie a été tronquée (probablement incomplète).

### Considérations sur le budget de jetons

Utilise des limites en jetons, pas en lignes. Les jetons sont l’unité que la fenêtre de contexte traite. Le scénario d’échec classique : le modèle ne produit jamais de jeton end-of-middle dans son budget, et la complétion s’arrête net en pleine expression. Pas terrible. Les utilisateurs remarquent vite quand leur auto-complétion suggère `const result = calculateTota` puis lâche l’affaire.

---

## Préambule et métadonnées

Quelques choix de formulation simples mais étonnamment efficaces.

### Chemin de fichier en commentaire

La plupart des prompts FIM ajoutent le chemin du fichier en commentaire dans le langage cible :

```python
# Path: src/utils/parser.py
```

```typescript
// Path: src/utils/parser.ts
```

Ça coûte quelques jetons, et le modèle peut en déduire une quantité surprenante rien qu’à partir du chemin. Ce que fait le module, quelles conventions de nommage attendre, quel framework est utilisé. C’est comme lire l’objet d’un courriel. En théorie facultatif, en pratique indispensable.

### Snippets liés en commentaires (mode FIM)

En mode FIM, le code d’autres fichiers va dans le préambule sous forme de commentaires, avant le préfixe proprement dit :

```typescript
// Path: src/index.ts
// --- src/utils.ts ---
// export function formatDate(date: Date): string {
//   return date.toISOString().split('T')[0];
// }
import { formatDate } from "./utils";
// ... suite du préfixe
```

C’est élégant. Les snippets liés ne sont que du « préfixe » du point de vue du modèle. La structure FIM reste propre, et on a quand même le contexte inter-fichiers. Pas de XML, pas de jetons spéciaux, juste des commentaires.

### Contexte XML structuré (mode chat)

En mode chat, les données structurées fonctionnent mieux que les commentaires :

```xml
<related_context>
--- src/utils.ts ---
export function formatDate(date: Date): string { ... }
</related_context>
```

---

## Choisir un modèle

C’est ce qui surprend le plus. Pour l’auto-complétion intégrée, les petits modèles spécialisés battent les gros généralistes à tout coup. Il n’y a même pas photo.

Côté open source, Qwen2.5-Coder en tailles 1.5B et 7B obtient les meilleurs résultats sur les benchmarks FIM publiés par son équipe[^13] et est le modèle open recommandé par Continue.[^14] Pour les modèles propriétaires, Codestral[^15] et Mercury Coder[^16] sont en tête des recommandations de Continue.[^14] La plage optimale est 1.5B–7B ; la doc de Continue indique que « la plupart des modèles d’auto-complétion de pointe ne dépassent pas 10B de paramètres, et augmenter au-delà n’améliore guère les performances ».[^3] Les modèles propriétaires sont un peu meilleurs que les modèles open source d’après les benchmarks de Continue,[^4] mais l’écart est faible. Quant aux modèles de chat pour l’auto-complétion, n’y pense même pas. Ils n’ont pas l’entraînement FIM et [« auront souvent de mauvais résultats même avec un prompting élaboré »](https://github.com/continuedev/continue/blob/32d7ba280f4cbb0052d9d07786865c8ebebea8f1/docs/customize/model-roles/autocomplete.mdx) (ce sont les mots de Continue, pas les nôtres). Ce point a déjà été abordé en section 3, avec la même conclusion.

Pour un usage en production avec des réponses en moins de 500 ms, le meilleur compromis est un modèle FIM de 1–7B couplé à une bonne collecte de contexte. Le contexte compte plus que la taille du modèle — un petit modèle bien nourri bat un gros modèle affamé à tous les coups. En ingénierie ML, c’est comme manger ses légumes : pas glamour, efficace, et facile à remettre à plus tard.

---

## Références

### Implémentations open source

- [Continue.dev AutocompleteTemplate.ts](https://github.com/continuedev/continue/blob/main/core/autocomplete/templating/AutocompleteTemplate.ts)
- [Continue.dev Context Selection](https://docs.continue.dev/ide-extensions/autocomplete/context-selection)
- [Continue.dev Root Path Context](https://web.archive.org/web/20251118163602/https://blog.continue.dev/root-path-context-the-secret-ingredient-in-continues-autocomplete-prompt/)
- [Tabby Code Completion Service (DeepWiki)](https://deepwiki.com/TabbyML/tabby/3.2-code-completion-service)
- [Cody Autocomplete](https://sourcegraph.com/docs/cody/capabilities/autocomplete)
- [Cody Context Architecture](https://sourcegraph.com/blog/how-cody-understands-your-codebase)
- [The Lifecycle of a Code AI Completion (Sourcegraph)](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion)

### Documentation des modèles

- [DeepSeek FIM Completion API](https://api-docs.deepseek.com/guides/fim_completion)
- [Mistral Codestral FIM endpoint](https://docs.mistral.ai/api/endpoint/fim)
- [Qwen2.5-Coder FIM (DeepWiki)](https://deepwiki.com/QwenLM/Qwen2.5-Coder/2.2-fill-in-the-middle)
- [How to Prompt Code Llama (Ollama)](https://ollama.com/blog/how-to-prompt-code-llama)
- [StarCoder2 FIM Instructions](https://huggingface.co/bigcode/starcoder2-15b/discussions/6)

### Lectures complémentaires

- [Efficient Training of Language Models to Fill in the Middle (Bavarian et al., 2022)](https://arxiv.org/abs/2207.14255) — L’article fondateur sur le FIM. Formats PSM/SPM, optimisation du taux FIM
- [Improving FIM Code Completions via Context & Curriculum Based Learning (2024)](https://arxiv.org/abs/2412.16589) — Contexte au niveau du dépôt, apprentissage par curriculum pour le FIM, gain de 6,25 % à 1B contre 1,25 % à 7B
- [Evaluation of LLMs on Syntax-Aware Code Fill-in-the-Middle Tasks (2024)](https://arxiv.org/abs/2403.04814) — Benchmark SAFIM, évaluation du post-traitement guidé par la syntaxe (ICML 2024 Oral)
- [Structure-Aware Fill-in-the-Middle Pretraining for Code (2025)](https://arxiv.org/abs/2506.00204) — Méthode d’entraînement AST-FIM, jusqu’à 5 points d’amélioration par masquage aligné sur l’AST
- [Horizon-Length Prediction: Advancing FIM Capabilities (Ding et al., 2024)](https://arxiv.org/abs/2410.03103) — Objectif d’entraînement HLP, jusqu’à 24 % d’amélioration FIM
- [Context Composing for Full Line Code Completion (2024)](https://arxiv.org/abs/2402.09230) — Contexte par chemin de fichier, optimisation du budget de jetons, +40 % de qualité en passant de 384 à 1536 jetons (ICSE 2024 IDE workshop ; DOI : 10.1145/3643796.3648446)
- [Prompt-based Code Completion via Multi-Retrieval Augmented Generation (2024)](https://arxiv.org/html/2405.07530v1) — RAG pour la complétion de code
- [Bridging Developer Instructions and Code Completion Through IFIM (Sun et al., 2025)](https://arxiv.org/abs/2509.24637) — FIM guidé par instruction, améliorations de la précision d’intention

### Références

[^1]: Ding, Yifeng, et al. "Horizon-Length Prediction: Advancing Fill-in-the-Middle Capabilities for Code Generation with Lookahead Planning." _arXiv_, 2024, https://arxiv.org/abs/2410.03103.

[^2]: Gong, Linyuan, et al. "Structure-Aware Fill-in-the-Middle Pretraining for Code." _arXiv_, 2025, https://arxiv.org/abs/2506.00204.

[^3]: Continue.dev. "Autocomplete Deep Dive." _GitHub_, https://github.com/continuedev/continue/blob/cbb705427f9e90f373cb0d12c904bb95beaa8566/docs/customize/deep-dives/autocomplete.mdx. Accessed 1 Mar. 2026.

[^4]: Continue.dev. "Autocomplete Model Roles." _Continue Documentation_, https://docs.continue.dev/customize/model-roles/autocomplete. Accessed 1 Mar. 2026.

[^6]: BigCode. "StarCoder2 FIM Instructions." _Hugging Face_, https://huggingface.co/bigcode/starcoder2-15b/discussions/6. Accessed 1 Mar. 2026.

[^7]: Meta. "CodeLlama Tokenizer Source." _GitHub_, https://github.com/meta-llama/codellama/blob/main/llama/tokenizer.py. Accessed 1 Mar. 2026.

[^8]: DeepSeek. "FIM Completion API." _DeepSeek API Docs_, https://api-docs.deepseek.com/guides/fim_completion. Accessed 1 Mar. 2026.

[^9]: Mistral AI. "FIM Endpoint." _Mistral API Documentation_, https://docs.mistral.ai/api/endpoint/fim. Accessed 1 Mar. 2026.

[^10]: Stability AI. "Stable Code 3B." _Hugging Face_, https://huggingface.co/stabilityai/stable-code-3b. Accessed 1 Mar. 2026.

[^11]: Z.ai. "CodeGeeX4 Infilling Guideline." _GitHub_, https://github.com/zai-org/CodeGeeX4/blob/main/guides/Infilling_guideline.md. Accessed 1 Mar. 2026.

[^12]: GitHub. "Responsible Use of GitHub Copilot Inline Suggestions." _GitHub Docs_, https://docs.github.com/en/copilot/responsible-use/copilot-code-completion. Accessed 1 Mar. 2026.

[^13]: Hui, Binyuan, et al. "Qwen2.5-Coder Technical Report." _arXiv_, 2024, https://arxiv.org/abs/2409.12186.

[^14]: Continue.dev. "Autocomplete Model Setup." _Continue Documentation_, https://docs.continue.dev/ide-extensions/autocomplete/model-setup. Accessed 1 Mar. 2026.

[^15]: Mistral AI. "Codestral 25.01." _Mistral AI News_, 2025, https://mistral.ai/news/codestral-2501.

[^16]: Khanna, Samar, et al. "Mercury: Ultra-Fast Language Models Based on Diffusion." _arXiv_, 2025, Table 3, https://arxiv.org/abs/2506.17298.

[^17]: DeepSeek. "deepseek-coder-1.3b-base Tokenizer." _Hugging Face_, tokens 32015–32017, https://huggingface.co/deepseek-ai/deepseek-coder-1.3b-base/raw/main/tokenizer.json. Accessed 1 Mar. 2026.

[^18]: Gong, Linyuan, et al. "Evaluation of LLMs on Syntax-Aware Code Fill-in-the-Middle Tasks." _Proceedings of the 41st International Conference on Machine Learning (ICML 2024)_, Oral presentation, 2024. Preprint: _arXiv_, https://arxiv.org/abs/2403.04814.

[^19]: Guo, Tianyu, et al. "EFIM: Efficient Serving of LLMs for Infilling Tasks with Improved KV Cache Reuse." _arXiv_, 2025, Section 2.2: "changes to the tail of the prefix invalidate the KV cache of the suffix" in PSM. https://arxiv.org/abs/2505.21889.
