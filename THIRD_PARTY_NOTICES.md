# Third-Party Notices

This package is licensed under [MIT](LICENSE). Two files reproduce code from DeepSeek projects, each MIT-licensed; those projects remain under their own licenses and nothing here changes those terms.

## Reproduced source

| File | From | License | Copyright |
| --- | --- | --- | --- |
| `estimate.js` | `@deepseek-ai/dsh-token-meter` (DeepSeek Harness) | MIT | Copyright (c) 2026 DeepSeek |
| `serve.js` | `deepseek-recipe` — `deepseek-recipe-encoding/src/v4/mod.rs`, `deepseek-recipe-encoding/src/v4/dsv41.rs`, `deepseek-recipe-core/src/util/json_formatter.rs` | MIT | Copyright (c) 2026 DeepSeek |

`estimate.js` is a verbatim copy: the estimator ships with the Harness, and this plugin's figures equal the ones the Harness's own context meter reports for the same session. It is copied rather than imported because an installed bundle resolves its imports from its own directory, where the Harness packages are not visible.

`serve.js` is a transcription rather than a copy: the same markers, the same order and the same joins, written in JavaScript. Its tool block is reproduced word for word, because those words are what the model reads.

Both upstream projects are MIT, so the notice below travels with both files.

## Upstream notice

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Not reproduced

The plugin calls the DeepSeek Harness only through its published extension points (`sessionProjections`, slot registration, the locale registry) and imports no harness package at runtime. `client.js` requires `react`, which the Web application provides.
