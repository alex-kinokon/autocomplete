# Autocomplete

[English](README.md)

Extension VS Code qui fournit des suggestions en ligne. Compatible avec toute API au format OpenAI.

Cette extension n’est pas un agent de programmation. Elle fait uniquement de l’autocomplétion.

## Installation

```sh
pnpm install
pnpm run build
```

Pour tester localement, lancez la configuration « Run Extension » (panneau Exécuter et déboguer) pour ouvrir un Extension Development Host. Ou empaquetez en VSIX :

```sh
pnpm run package
code --install-extension *.vsix
# pour VSCodium
codium --install-extension *.vsix
```

## Configuration

Les réglages se trouvent sous `autocomplete.*` dans les paramètres VS Code. Le endpoint par défaut est `http://localhost:11434/v1` ; il suffit de définir un modèle :

```json
{
  "autocomplete.model": "qwen2.5-coder:1.5b"
}
```

Ou utilisez un autre endpoint :

```json
{
  "autocomplete.endpoint": "http://localhost:8000/v1",
  "autocomplete.model": "deepseek-coder"
}
```

### FIM (Fill-in-the-Middle)

En mode FIM, l’extension envoie au modèle le code avant et après le curseur via `/completions`, ce qui améliore la qualité des suggestions. Sans FIM, elle utilise `/chat/completions` à la place.

Par défaut, `autocomplete.fim.mode` vaut `"auto"` : l’extension détecte automatiquement la prise en charge du FIM. Elle vérifie d’abord s’il s’agit d’un serveur Ollama ; si c’est le cas, elle interroge le modèle pour vérifier ses capacités. Pour les autres serveurs, elle passe directement en mode chat. Vous pouvez aussi choisir le mode manuellement :

**Géré par le serveur** (Ollama, LM Studio) -- le serveur applique son propre formatage FIM :

```json
{
  "autocomplete.endpoint": "http://localhost:11434/v1",
  "autocomplete.model": "qwen2.5-coder:1.5b",
  "autocomplete.fim.mode": "server-managed"
}
```

**Insertion manuelle de jetons** (vLLM, llama.cpp) -- pour les serveurs qui attendent des jetons FIM bruts dans le prompt :

```json
{
  "autocomplete.endpoint": "http://localhost:8000/v1",
  "autocomplete.model": "deepseek-coder",
  "autocomplete.fim.mode": "custom",
  "autocomplete.fim.prefix": "<fim_prefix>",
  "autocomplete.fim.suffix": "<fim_suffix>",
  "autocomplete.fim.middle": "<fim_middle>"
}
```

Formats de jetons FIM courants pour le mode personnalisé :

| Modèle    | prefix             | suffix             | middle             |
| --------- | ------------------ | ------------------ | ------------------ |
| DeepSeek  | `<fim_prefix>`     | `<fim_suffix>`     | `<fim_middle>`     |
| CodeLlama | `<PRE>`            | `<SUF>`            | `<MID>`            |
| StarCoder | `<fim_prefix>`     | `<fim_suffix>`     | `<fim_middle>`     |
| Qwen      | `<\|fim_prefix\|>` | `<\|fim_suffix\|>` | `<\|fim_middle\|>` |

### Tous les paramètres

| Paramètre                   | Type     | Défaut                      | Description                                                   |
| --------------------------- | -------- | --------------------------- | ------------------------------------------------------------- |
| `autocomplete.enable`       | boolean  | `true`                      | Activer/désactiver l’extension                                |
| `autocomplete.debug`        | boolean  | `false`                     | Journaliser les détails des requêtes/réponses                 |
| `autocomplete.endpoint`     | string   | `http://localhost:11434/v1` | URL de base de l’API compatible OpenAI                        |
| `autocomplete.model`        | string   |                             | Identifiant du modèle                                         |
| `autocomplete.maxTokens`    | number   | `256`                       | Nombre maximum de jetons dans la réponse                      |
| `autocomplete.temperature`  | number   | `0.2`                       | Température d’échantillonnage                                 |
| `autocomplete.stop`         | string[] | `["\n\n"]`                  | Séquences d’arrêt                                             |
| `autocomplete.fim.mode`     | string   | `"auto"`                    | `"auto"`, `"off"`, `"server-managed"` ou `"custom"`           |
| `autocomplete.fim.prefix`   | string   |                             | Jeton de préfixe FIM (mode personnalisé)                      |
| `autocomplete.fim.suffix`   | string   |                             | Jeton de suffixe FIM (mode personnalisé)                      |
| `autocomplete.fim.middle`   | string   |                             | Jeton du milieu FIM (mode personnalisé)                       |
| `autocomplete.debounceMs`   | number   | `300`                       | Délai en ms avant l’envoi d’une requête                       |
| `autocomplete.contextLines` | number   | `100`                       | Lignes de contexte autour du curseur                          |
| `autocomplete.systemPrompt` | string   |                             | Prompt système personnalisé pour les complétions en mode chat |
| `autocomplete.excludeFiles` | string[] | `[]`                        | Motifs glob supplémentaires pour exclure des fichiers         |

Les fichiers correspondant à `.env`, `.env.*`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, ainsi que les fichiers dans les répertoires `.ssh/`, `.aws/` ou `.gnupg/` sont toujours exclus. Utilisez `autocomplete.excludeFiles` pour ajouter des motifs supplémentaires (ex. `["*.log", "secrets.yaml"]`).

Commandes (palette) : `Autocomplete : Activer`, `Autocomplete : Désactiver`, `Autocomplete : Choisir un modèle`, `Autocomplete : Choisir un modèle (Workspace)`, `Autocomplete : Définir la clé API`, `Autocomplete : Supprimer la clé API`.

« Choisir un modèle » récupère la liste des modèles via `/v1/models`, compatible avec tout serveur au format OpenAI. Avec un serveur Ollama, des détails supplémentaires sont affichés (taille des paramètres, quantification, taille sur disque).

## Fonctionnement

Au fil de la saisie, l’extension :

1. Attend la fin de la temporisation
2. Extrait le contexte du code (préfixe/suffixe) autour du curseur
3. Envoie une requête au endpoint configuré
4. Affiche la réponse sous forme de suggestion intégrée

En continuant à taper, la requête en cours est automatiquement annulée. Les résultats sont mis en cache selon le contexte du curseur (jusqu’à 75 entrées).

## Licence

GNU General Public License v3.0 ou ultérieure.

## Développement

```sh
pnpm build          # empaqueter dans dist/
pnpm watch          # recompiler au changement
pnpm typecheck      # exécuter tsc --noEmit
pnpm lint           # exécuter eslint
pnpm lint:fix       # exécuter eslint --fix
pnpm test           # exécuter vitest
```

### Compatibilité WASM tree-sitter

L’extension charge des grammaires WASM pré-compilées (`tree-sitter-wasms`) via `web-tree-sitter`. Les deux paquets doivent utiliser des versions ABI compatibles ; sinon, le chargement des grammaires échoue silencieusement.

`tree-sitter-wasms@0.1.x` compile ses grammaires avec `tree-sitter-cli@0.20.x`. À partir de `web-tree-sitter@0.26+`, une rupture d’ABI empêche leur chargement. C’est pourquoi `web-tree-sitter` est épinglé à `0.25.10`. Ne la mettez pas à jour sans vérifier que les grammaires se chargent correctement.

### Limitations connues

- `autocomplete.debug` lit la configuration globale sans URI de ressource. Dans un espace de travail multi-racines avec des surcharges par dossier, la journalisation de débogage peut ne pas respecter le réglage du dossier du document actif. Pour y remédier, il faudrait propager un URI de document à chaque appel `log.debug()`.
- Le cache de complétion se base uniquement sur l’URI du document et le texte autour du curseur. Si un autre fichier est modifié (snippets liés, définitions), le cache peut servir un résultat obsolète tant que le texte local reste inchangé.
- La déduplication des snippets de définition se fait par chemin relatif. Dans un espace de travail multi-racines, deux fichiers avec le même chemin relatif (par ex. `src/utils.ts` dans deux racines différentes) peuvent entrer en collision, et l’un d’eux sera silencieusement ignoré.
