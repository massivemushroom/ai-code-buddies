const buddy_config = require('./config.js');

buddy_config.run_setup();

const max_model_token = 8100; //8192
const max_model_answer_token_reserve = 4025; //4096

const model_name = "gpt-4";
//const model_name = "gpt-3.5";
const github_actions = require('@actions/github');
const github_actions_core = require('@actions/core');
const openai_api = require('openai');
const fetch = require("node-fetch");
globalThis.fetch = fetch;
const { Tiktoken } = require("@dqbd/tiktoken/lite");
const { load } = require("@dqbd/tiktoken/load");
const registry = require("@dqbd/tiktoken/registry.json");
const models = require("@dqbd/tiktoken/model_to_encoding.json");
let skip_all_reviews = false;

function sleep(ms)
{
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const filter_extensions = (files, extensions) =>
{
  const exts = extensions.split(',').map((ext) => ext.trim());
  return files.filter((file) => exts.some((ext) => file.filename.endsWith(ext)));
};

const filter_excluded = (files, paths) =>
{
  const excluded_paths = paths.split(',').map((path) => path.trim());
  return files.filter((file) => !excluded_paths.some((path) => file.filename.startsWith(path)));
};

const apply_file_filters = (changed_files, file_extensions, exclude_paths) =>
{
  let filtered_files = changed_files;

  if(file_extensions)
  {
    filtered_files = filter_extensions(filtered_files, file_extensions);
  }

  if(exclude_paths)
  {
    filtered_files = filter_excluded(filtered_files, exclude_paths);
  }

  return filtered_files;
};

const get_files_content = async (filteredChangedFiles, octokit, owner, repo, branchName) =>
{
  let filesWithContents = new Map;
  for(const file of filteredChangedFiles)
  {
    const {data: fileContent} = await octokit.rest.repos.getContent({
      owner, repo, path: file.filename, ref: branchName,
    });

    console.log(`processing ${file.filename}`);
    filesWithContents.set(file.filename, Buffer.from(fileContent.content, 'base64').toString('utf-8'));
  }

  console.log(`total files added:  ${filesWithContents.size}`);

  return filesWithContents;
};

async function gpt35_turbo_with_retries(message, encoder, maxRetries = 3, delay = 1000)
{
  let retries = 0;
  let response;

  const openai_api_key = github_actions_core.getInput('openai_api_key', {required: true});
  const openai_client = new openai_api.OpenAIApi(new openai_api.Configuration({apiKey: openai_api_key}));

  while(retries <= maxRetries)
  {
    try
    {
      let final_response = "";
      let used_tokens = encoder.encode(message[0].content + message[1].content).length;
      let remaining_tokens = (max_model_token - used_tokens);

      console.log(`remaining token count: ${remaining_tokens} used tokens : ${used_tokens}`);

      response = await openai_client.createChatCompletion({
        model: model_name, messages: message, max_tokens: remaining_tokens, n: 1
      });

      final_response += "\n\nReview\n---------------------------------------------\n\n";
      final_response += response.data.choices[0].message.content;
/*
      final_response += "\n\nReview 2\n---------------------------------------------\n\n";
      final_response += response.data.choices[1].message.content;
      final_response += "\n\nReview 3\n---------------------------------------------\n\n";
      final_response += response.data.choices[2].message.content;
      final_response += "\n\nReview 4\n---------------------------------------------\n\n";
      final_response += response.data.choices[3].message.content;
      final_response += "\n\nReview 5\n---------------------------------------------\n\n";
      final_response += response.data.choices[4].message.content;
*/
      // If successful, return the content immediately
      return final_response;
    } catch(error)
    {
      console.error(`Attempt ${retries + 1} failed: ${error.message}, ${error.response.status} `);
      console.error(error.response.data);
      retries++;

      // If we've reached the maximum number of retries, throw an error
      if(retries > maxRetries)
      {
        throw new Error(`Failed after ${maxRetries} attempts: ${error.message}`);
      }

      // Wait for the specified delay before trying again
      await sleep(delay);
    }
  }
}
async function check_comments_for_text(octokit, owner, repo, pull_number, searchText) {
  try {
    //pulls.listReviewComments
    const comments = await octokit.rest.issues.listComments({
      owner: owner,
      repo: repo,
      issue_number: pull_number,
      per_page: 100
    });

    for (const comment of comments.data) {
      if (comment.body.includes(searchText)) {
        return true;
      }
    }
  } catch (error) {
    console.error("Error fetching review comments:", error);
  }

  return false;
}
async function perform_review(prompt)
{
  const model = await load(registry[models[model_name]]);
  const encoder = new Tiktoken(
      model.bpe_ranks,
      model.special_tokens,
      model.pat_str
  );

  try
  {
    const token = github_actions_core.getInput('github_token', {required: true});
    const repo = github_actions.context.repo.repo;
    let pr_number = github_actions.context.payload.number;
    if(!pr_number)
    {
      pr_number = github_actions.context.payload.issue.number;
    }
    const owner = github_actions.context.repo.owner;
    const octokit = new github_actions.getOctokit(token);
    const pr_trigger_word = "buddies,-please-review-this-pr";
    const search_text = "buddies, please review this pr";

    console.log(`incoming : ${repo}, ${pr_number}, ${owner}`);

    if(!(await check_comments_for_text(octokit, owner, repo, pr_number, search_text)))
    {
      const comment = `Skipping AI buddy review, when ready please comment with \"${pr_trigger_word}\"`;
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: pr_number, body: comment,
      });
      skip_all_reviews = true;
      return;
    }

    const file_extensions = github_actions_core.getInput('source_file_extensions', {required: false});
    const exclude_paths = github_actions_core.getInput('exclude_paths', {required: false});

    const {data: prData} = await octokit.rest.pulls.get({
      owner, repo, pull_number: pr_number,
    });

    const branchName = prData.head.ref;
    const max_tokens = (max_model_token - (encoder.encode(prompt).length + max_model_answer_token_reserve));
    console.log(`max tokens after prompt: ${max_tokens}`);

    const {data: changedFiles} = await octokit.rest.pulls.listFiles({
      owner, repo, pull_number: pr_number,
    });
    const filteredChangedFiles = apply_file_filters(changedFiles, file_extensions, exclude_paths);
    let filesWithContents = await get_files_content(filteredChangedFiles, octokit, owner, repo, branchName);

    console.log(`will attempt to process all files: ${filesWithContents.size} files`)

    const process_files = async (files_to_process) =>
    {
      let total_token_count = 0;
      let user_message_content = "";
      let skipped_files = new Map;
      for(const [key, value] of files_to_process)
      {
        if(!value)
        {
          console.log(`file ${key} has no content`);
          continue;
        }
        let file_token_count = encoder.encode(value).length;

        console.log(`adding content from : ${key} token count : ${file_token_count}, max tokens: ${max_tokens} total including: ${total_token_count + file_token_count}`);

        if(total_token_count + file_token_count > max_tokens)
        {
          if(file_token_count > max_tokens)
          {
            console.log(`file ${key} is too large to submit. splitting content`);
            const first_half = value.slice(0, value.length / 2)
            const second_half = value.slice(value.length / 2, value.length)
            skipped_files.set(key + ".part_1", first_half);
            skipped_files.set(key + ".part_2", second_half);
          }else
          {
            console.log(`file ${key} cannot be processed, will save for later`);
            skipped_files.set(key, value);
          }
          continue;
        }else
        {
          console.log(`adding file ${key}`);
          user_message_content += `filename: ${key}` + value;
        }
        total_token_count += file_token_count;
      }

      if(user_message_content)
      {
        const GPT35TurboMessage = [
          {
            role: 'system', content: prompt,
          }, {
            role: 'user', content: user_message_content,
          },
        ];

        console.log("submitting request to openai");

        const comment = await gpt35_turbo_with_retries(GPT35TurboMessage, encoder, 3, 60000);
        await octokit.rest.issues.createComment({
          owner, repo, issue_number: pr_number, body: comment,
        });
      }else
      {
        console.log("no content : skipping.");
      }

      return skipped_files;
    };

    let remaining_files = filesWithContents;
    do{
      console.log(`in processing loop : ${remaining_files.size}`);
      remaining_files = new Map(await process_files(remaining_files));
    }while(remaining_files.size);

  } catch(error)
  {
    github_actions_core.setFailed(error.message);
  }

  encoder.free();
}

const main = async () =>
{
  // Get the input prompts
  const promptsInput = github_actions_core.getInput('prompts', {required: true});
  // Split the input string into an array of prompts
  const prompts = promptsInput.split(';').map(prompt => prompt.trim());
  const delay = 5000; // Set the desired delay in milliseconds between calls

  for(const prompt of prompts)
  {
    if(skip_all_reviews)
    {
      return;
    }
    await perform_review(prompt);
    await sleep(delay);
  }
};

main().then(r => console.log("done."));