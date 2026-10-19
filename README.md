# DocuWriter CLI

Start documentation from your terminal with [DocuWriter](https://www.docuwriter.ai). Generate structured documentation for your codebase or import existing Markdown files and their local images into a Space.

## Get started

Requires Node.js **22.18 or later** and a DocuWriter account. You can sign in or create an account during setup.

From your project folder, run:

```sh
npx @docuwriter-ai/cli
```

Confirm the folder, sign in through your browser, and choose whether to generate documentation or import existing docs. Follow the prompts; the CLI uploads your project snapshot and opens your Space.

You can close the terminal after upload acceptance. Follow generation or import progress in DocuWriter. Generation uses your plan’s access and available credits.

## Useful commands

```sh
npx @docuwriter-ai/cli --cwd ./packages/api
npx @docuwriter-ai/cli --no-open
npx @docuwriter-ai/cli login
npx @docuwriter-ai/cli logout
npx @docuwriter-ai/cli --help
```

`--cwd` selects a specific folder. `--no-open` prints links instead of opening your browser. Setup requires an interactive terminal.

## Privacy

Your code stays private and is not used to train AI models. Uploads include local edits and untracked files after Git ignore rules and credential/dependency exclusions are applied. Review your selected folder before continuing.

After sign-in, usage analytics include setup answers to help improve the experience. No anonymous analytics are collected. Disable analytics with `npx @docuwriter-ai/cli analytics off`.

## Support

Contact [support@docuwriter.ai](mailto:support@docuwriter.ai) or [report an issue](https://github.com/DocuWriter-ai/docuwriter-cli/issues).
