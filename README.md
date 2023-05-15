# ai-code-buddies

Perform code reviews using the OpenAI GPT-3.5-turbo and custom prompts. Code snippets will be submitted to the api and the results will be posted as comments in your pull-requests, each prompt will generate 1 api requests and 1 response in the PR. 

There are defaults for most of the inputs listed below, you can view them in the actions.yml.

https://www.playtheory.io/post/ai-assisted-reviews-on-github-now

## Inputs

### `openai_api_key`

**Required** Your OpenAI API key. This is needed to make requests to the OpenAI API.

### `source_file_extensions`

A comma-separated list of source file extensions to review (e.g., `.h, .c, .cpp`). Defaults to `.h,.cpp,.c`.

### `exclude_paths`

A comma-separated list of paths to exclude from the review process. Defaults to `_documentation/,_idea_templates/`.

### `github_token`

The GitHub token to use in your action. Defaults to `${{ github.token }}`. Only replace this input if you need custom permissions.

### `prompts`

A semicolon-separated list of prompts to use when submitting code to the OpenAI API. Each prompt will result in one submission to the API. Defaults to a list of 8 different prompts targeting different C++ code review scenarios.

## Usage

To use the `ai-code-buddies` GitHub Action, add the following snippet to your workflow YAML file:

```yaml
steps:
  - name: ai-code-buddies
    uses: playtheorygames/ai-code-buddies@v1.0.0
    with:
      openai_api_key: ${{ secrets.OPENAI_API_KEY }}
      source_file_extensions: ".h,.cpp,.c"
      exclude_paths: "_documentation/,_idea_templates/"
      github_token: ${{ github.token }}
      prompts: >-
        Your custom prompts here, separated by semicolons
```

Make sure to store your OpenAI API key in your repository secrets as `OPENAI_API_KEY`. Customize the `source_file_extensions`, `exclude_paths`, and `prompts` as needed.
