# Typewriter（AIR MAIL）

ブラウザで動く、**最後期の手動式・標準英文タイプライター**のシミュレーター。
打鍵すると印字点は固定のまま紙（キャリッジ）が動き、扇形のタイプバスケットでハンマーが振り上がります。

🔗 **公開版**: https://yamadar.github.io/typewriter/

![Typewriter](docs/figures/segment-convergence.svg)

## 特徴

- **単一 SHIFT**（大文字＋記号）／**Shift Lock は全段**に作用（現代の Caps Lock と異なる）
- **CR と LF を分離**（Enter = CR+LF / Shift+Enter = CR / Ctrl・Cmd+Enter = LF）
- **印字点は固定、紙（キャリッジ）が動く**（横→左、CR→右復帰、LF→上送り）
- **扇形タイプバスケット**：各キーのアーム→タイプバーが共通の打点へ収束（露出パーツとして描画）
- **CR レバー**：右へ引く＝CR／手前へ引く＝LF／クリック＝CR+LF
- **用紙解放レバー**：ローラーを解放して、タイプした紙だけを表示
- **マージンベル**（右端手前でチリーン）、**Backspace は重ね打ち**（消去しない）
- Web Audio による打鍵音／ベル／レバー音
- ロジックは **DOM 非依存の純粋な状態機械**＋ユニットテスト

## 操作

| 操作 | 入力 |
|---|---|
| 文字入力 | 各キー（クリック／物理キーボード） |
| 大文字・記号 | Shift（押している間） |
| 全段ロック | Shift Lock（CapsLock） |
| 改行（CR+LF） | Enter |
| CR のみ | Shift+Enter ／ CR レバーを右に引く |
| LF のみ | Ctrl・Cmd+Enter ／ CR レバーを手前に引く ／ 改行ノブ |
| 後退（重ね打ち） | Backspace |
| 紙を取り出す | 用紙解放レバー |

最初の画面をクリックすると開始します（音 ON・キー入力受付）。

## 実行

依存ゼロの静的サイトです。

```bash
# ローカルサーバ（編集が即反映：no-cache）
python3 serve.py            # → http://localhost:8123
```

`index.html` を直接ブラウザで開いても動作します。

## テスト

状態機械（`typewriter-model.js`）を Node 内蔵テストランナーで検証します（依存なし）。

```bash
node --test                 # 18 件
```

## 構成

```
index.html              画面構造
style.css               スタイル（円形キー・レバー・扇形バスケット枠）
typewriter-model.js     純粋ロジック（桁/行・エスケープメント・SHIFT・CR/LF・ベル）
script.js               表示/入力層（canvas 描画・Web Audio・入力配線）
test/                   ユニットテスト（node:test）
serve.py                no-cache 開発サーバ
docs/typewriter-mechanism.md   機構の詳細解説（図つき）
```

## 公開（GitHub Pages）

`main` ブランチに push すると GitHub Pages が自動で再公開します（ルートを配信、`.nojekyll` で静的配信）。
