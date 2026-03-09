# Claudex

Open AI CodexモデルをClaude Code CLIで利用するためのプロキシラッパー。

## 前提条件

- Node.js 20 以上
- [Codex CLI](https://github.com/openai/codex) がインストール済みであること (認証用)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) がインストール済みであること

## 1.セットアップ

```bash
npm install -g user-s0ma/claudex
```

## 2.認証

認証情報は [Codex CLI](https://github.com/openai/codex) のログインで設定します。

```bash
codex --login
```

## 3.使い方

Claude Code と同じ引数をそのまま渡せます。

```bash
claudex
```

## a.設定画面

対話的な設定画面が起動します。矢印キーで項目を選択し、Enter で編集できます。

```bash
claudex setting
```

設定項目:

| 項目 | 説明 |
|------|------|
| Base URL | APIエンドポイント |
| API Key | APIキー |
| Model | 使用するモデル (一覧から選択 or 手動入力) |
| Effort | 推論エフォート (low / medium / high / xhigh or 手動入力) |

設定の優先順位:

```
環境変数  >  config.json  >  デフォルト値
```

環境変数:

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `CLAUDEX_BASE_URL` | APIエンドポイント | `https://chatgpt.com/backend-api/codex` |
| `CLAUDEX_API_KEY` | APIキー | auth.json から取得 |
| `CLAUDEX_MODEL` | 使用するモデル | `gpt-5.4` |
| `CLAUDEX_EFFORT` | 推論エフォート | `high` |
