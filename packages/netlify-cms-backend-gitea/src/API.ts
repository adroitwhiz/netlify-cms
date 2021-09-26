
import {
  localForage,
  parseLinkHeader,
  unsentRequest,
  then,
  APIError,
  Cursor,
  readFile,
  CMS_BRANCH_PREFIX,
  generateContentKey,
  isCMSLabel,
  EditorialWorkflowError,
  labelToStatus,
  statusToLabel,
  DEFAULT_PR_BODY,
  MERGE_COMMIT_MESSAGE,
  responseParser,
  PreviewState,
  parseContentKey,
  branchFromContentKey,
  requestWithBackoff,
  readFileMetadata,
  throwOnConflictingBranches,
} from 'netlify-cms-lib-util';
import { Base64 } from 'js-base64';
import { Map } from 'immutable';
import { flow, partial, result, trimStart } from 'lodash';
import { dirname } from 'path';

import type {
  ApiRequest,
  DataFile,
  AssetProxy,
  PersistOptions,
  FetchError
} from 'netlify-cms-lib-util';

export const API_NAME = 'Gitea';

export interface Config {
  apiRoot?: string;
  token?: string;
  branch?: string;
  repo?: string;
  squashMerges: boolean;
  initialWorkflowStatus: string;
  cmsLabelPrefix: string;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

enum CommitAction {
  CREATE = 'create',
  DELETE = 'delete',
  MOVE = 'move',
  UPDATE = 'update',
}

type GiteaUser = {
  active: boolean,
  avatar_url: string,
  created: string,
  description: string,
  email: string,
  followers_count: number,
  following_count: number,
  full_name: string,
  id: number,
  is_admin: boolean,
  language: string,
  last_login: string,
  location: string,
  login: string,
  prohibit_login: boolean,
  restricted: boolean,
  starred_repos_count: number,
  visibility: 'public' | 'limited' | 'private',
  website: string
};

export function getMaxAccess(groups: { group_access_level: number }[]) {
  return groups.reduce((previous, current) => {
    if (current.group_access_level > previous.group_access_level) {
      return current;
    }
    return previous;
  }, groups[0]);
};

export default class API {
  apiRoot: string;
  token: string | boolean;
  branch: string;
  useOpenAuthoring?: boolean;
  repo: string;
  repoURL: string;
  commitAuthor?: CommitAuthor;
  squashMerges: boolean;
  initialWorkflowStatus: string;
  cmsLabelPrefix: string;

  constructor(config: Config) {
    this.apiRoot = config.apiRoot || 'https://gitea.com/api/v1';
    this.token = config.token || false;
    this.branch = config.branch || 'master';
    this.repo = config.repo || '';
    this.repoURL = `/repos/${this.repo.split('/').map(part => encodeURIComponent(part)).join('/')}`;
    this.squashMerges = config.squashMerges;
    this.initialWorkflowStatus = config.initialWorkflowStatus;
    this.cmsLabelPrefix = config.cmsLabelPrefix;
  }

  withAuthorizationHeaders = (req: ApiRequest) => {
    const withHeaders = unsentRequest.withHeaders(
      this.token ? { Authorization: `Bearer ${this.token}` } : {},
      req,
    );
    return Promise.resolve(withHeaders);
  };

  buildRequest = async (req: ApiRequest) => {
    const withRoot: ApiRequest = unsentRequest.withRoot(this.apiRoot)(req);
    const withAuthorizationHeaders = await this.withAuthorizationHeaders(withRoot);

    if (withAuthorizationHeaders.has('cache')) {
      return withAuthorizationHeaders;
    } else {
      const withNoCache: ApiRequest = unsentRequest.withNoCache(withAuthorizationHeaders);
      return withNoCache;
    }
  };

  request = async (req: ApiRequest): Promise<Response> => {
    try {
      return requestWithBackoff(this, req);
    } catch (err) {
      throw new APIError((err as Error).message, null, API_NAME);
    }
  };

  responseToJSON = responseParser({ format: 'json', apiName: API_NAME });
  responseToBlob = responseParser({ format: 'blob', apiName: API_NAME });
  responseToText = responseParser({ format: 'text', apiName: API_NAME });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestJSON = <T>(req: ApiRequest & {}) => this.request(req).then(this.responseToJSON) as Promise<T>;
  requestText = (req: ApiRequest) => this.request(req).then(this.responseToText) as Promise<string>;

  user = (): Promise<{ name: string, login: string }> => this.requestJSON('/user');

  WRITE_ACCESS = 30;
  MAINTAINER_ACCESS = 40;

  hasWriteAccess = async () => {
    const {permissions}: GiteaRepo = await this.requestJSON<GiteaRepo>(this.repoURL);

    return permissions.push;
  };

  readFile = async (
    path: string,
    sha?: string | null,
    { parseText = true, branch = this.branch } = {},
  ): Promise<string | Blob> => {
    const fetchContent = async () => {
      const content = await this.request({
        url: `${this.repoURL}/repository/files/${encodeURIComponent(path)}/raw`,
        params: { ref: branch },
        cache: 'no-store',
      }).then<Blob | string>(parseText ? this.responseToText : this.responseToBlob);
      return content;
    };

    const content = await readFile(sha, fetchContent, localForage, parseText);
    return content;
  };

  async readFileMetadata(path: string, sha: string | null | undefined) {
    const fetchFileMetadata = async () => {
      try {
        const result: GiteaCommit[] = await this.requestJSON({
          url: `${this.repoURL}/repository/commits`,
          params: { path, ref_name: this.branch },
        });
        const commit = result[0];
        return {
          author: commit.author_name || commit.author_email,
          updatedOn: commit.authored_date,
        };
      } catch (e) {
        return { author: '', updatedOn: '' };
      }
    };
    const fileMetadata = await readFileMetadata(sha, fetchFileMetadata, localForage);
    return fileMetadata;
  }

  getCursorFromHeaders = (headers: Headers) => {
    const page = parseInt(headers.get('X-Page') as string, 10);
    const pageCount = parseInt(headers.get('X-Total-Pages') as string, 10);
    const pageSize = parseInt(headers.get('X-Per-Page') as string, 10);
    const count = parseInt(headers.get('X-Total') as string, 10);
    const links = parseLinkHeader(headers.get('Link'));
    const actions = Map(links)
      .keySeq()
      .flatMap(key =>
        (key === 'prev' && page > 1) ||
        (key === 'next' && page < pageCount) ||
        (key === 'first' && page > 1) ||
        (key === 'last' && page < pageCount)
          ? [key]
          : [],
      );
    return Cursor.create({
      actions,
      meta: { page, count, pageSize, pageCount },
      data: { links },
    });
  };

  getCursor = ({ headers }: { headers: Headers }) => this.getCursorFromHeaders(headers);

  // Gets a cursor without retrieving the entries by using a HEAD
  // request
  fetchCursor = (req: ApiRequest) =>
    flow([unsentRequest.withMethod('HEAD'), this.request, then(this.getCursor)])(req);

  fetchCursorAndEntries = (
    req: ApiRequest,
  ): Promise<{
    entries: { id: string; type: string; path: string; name: string }[];
    cursor: Cursor;
  }> =>
    flow([
      unsentRequest.withMethod('GET'),
      this.request,
      p =>
        Promise.all([
          p.then(this.getCursor),
          p.then(this.responseToJSON).catch((e: FetchError) => {
            if (e.status === 404) {
              return [];
            } else {
              throw e;
            }
          }),
        ]),
      then(([cursor, entries]: [Cursor, {}[]]) => ({ cursor, entries })),
    ])(req);

  listFiles = async (path: string, recursive = false) => {
    const { entries, cursor } = await this.fetchCursorAndEntries({
      url: `${this.repoURL}/repository/tree`,
      params: { path, ref: this.branch, recursive },
    });
    return {
      files: entries.filter(({ type }) => type === 'blob'),
      cursor,
    };
  };

  traverseCursor = async (cursor: Cursor, action: string) => {
    const link = cursor.data!.getIn(['links', action]);
    const { entries, cursor: newCursor } = await this.fetchCursorAndEntries(link);
    return {
      entries: entries.filter(({ type }) => type === 'blob'),
      cursor: newCursor,
    };
  };

  listAllFiles = async (path: string, recursive = false, branch = this.branch) => {
    const entries = [];
    // eslint-disable-next-line prefer-const
    let { cursor, entries: initialEntries } = await this.fetchCursorAndEntries({
      url: `${this.repoURL}/repository/tree`,
      // Get the maximum number of entries per page
      params: { path, ref: branch, per_page: 100, recursive },
    });
    entries.push(...initialEntries);
    while (cursor && cursor.actions!.has('next')) {
      const link = cursor.data!.getIn(['links', 'next']);
      const { cursor: newCursor, entries: newEntries } = await this.fetchCursorAndEntries(link);
      entries.push(...newEntries);
      cursor = newCursor;
    }
    return entries.filter(({ type }) => type === 'blob');
  };

  toBase64 = (str: string) => Promise.resolve(Base64.encode(str));
  fromBase64 = (str: string) => Base64.decode(str);

  async getBranch(branchName: string) {
    const branch: GiteaBranch = await this.requestJSON(
      `${this.repoURL}/repository/branches/${encodeURIComponent(branchName)}`,
    );
    return branch;
  }

  async uploadAndCommit(
    items: CommitItem[],
    { commitMessage = '', branch = this.branch, newBranch = false },
  ) {
    const actions = items.map(item => ({
      action: item.action,
      file_path: item.path,
      ...(item.oldPath ? { previous_path: item.oldPath } : {}),
      ...(item.base64Content !== undefined
        ? { content: item.base64Content, encoding: 'base64' }
        : {}),
    }));

    const commitParams: CommitsParams = {
      branch,
      commit_message: commitMessage,
      actions,
      ...(newBranch ? { start_branch: this.branch } : {}),
    };
    if (this.commitAuthor) {
      const { name, email } = this.commitAuthor;
      commitParams.author_name = name;
      commitParams.author_email = email;
    }

    try {
      const result = await this.requestJSON({
        url: `${this.repoURL}/repository/commits`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(commitParams),
      });
      return result;
    } catch (error) {
      const message = (error as Error).message || '';
      if (newBranch && message.includes(`Could not update ${branch}`)) {
        await throwOnConflictingBranches(branch, name => this.getBranch(name), API_NAME);
      }
      throw error;
    }
  }

  async getCommitItems(files: { path: string; newPath?: string }[], branch: string) {
    const items: CommitItem[] = await Promise.all(
      files.map(async file => {
        const [base64Content, fileExists] = await Promise.all([
          result(file, 'toBase64', partial(this.toBase64, (file as DataFile).raw)),
          this.isFileExists(file.path, branch),
        ]);

        let action = CommitAction.CREATE;
        let path = trimStart(file.path, '/');
        let oldPath = undefined;
        if (fileExists) {
          oldPath = file.newPath && path;
          action =
            file.newPath && file.newPath !== oldPath ? CommitAction.MOVE : CommitAction.UPDATE;
          path = file.newPath ? trimStart(file.newPath, '/') : path;
        }

        return {
          action,
          base64Content,
          path,
          oldPath,
        };
      }),
    );

    // move children
    for (const item of items.filter(i => i.oldPath && i.action === CommitAction.MOVE)) {
      const sourceDir = dirname(item.oldPath as string);
      const destDir = dirname(item.path);
      const children = await this.listAllFiles(sourceDir, true, branch);
      children
        .filter(f => f.path !== item.oldPath)
        .forEach(file => {
          items.push({
            action: CommitAction.MOVE,
            path: file.path.replace(sourceDir, destDir),
            oldPath: file.path,
          });
        });
    }

    return items;
  }

  async persistFiles(dataFiles: DataFile[], mediaFiles: AssetProxy[], options: PersistOptions) {
    const files = [...dataFiles, ...mediaFiles];
    if (options.useWorkflow) {
      const slug = dataFiles[0].slug;
      return this.editorialWorkflowGit(files, slug, options);
    } else {
      const items = await this.getCommitItems(files, this.branch);
      return this.uploadAndCommit(items, {
        commitMessage: options.commitMessage,
      });
    }
  }

  deleteFiles = (paths: string[], commitMessage: string) => {
    const branch = this.branch;
    const commitParams: CommitsParams = { commit_message: commitMessage, branch };
    if (this.commitAuthor) {
      const { name, email } = this.commitAuthor;
      commitParams.author_name = name;
      commitParams.author_email = email;
    }

    const items = paths.map(path => ({ path, action: CommitAction.DELETE }));
    return this.uploadAndCommit(items, {
      commitMessage,
    });
  };

  async getPullRequests(sourceBranch?: string) {
    const pullRequests: GiteaPullRequest[] = await this.requestJSON({
      url: `${this.repoURL}/pulls`,
      params: {
        state: 'opened',
        labels: 'Any',
        target_branch: this.branch,
        ...(sourceBranch ? { source_branch: sourceBranch } : {}),
      },
    });

    return pullRequests.filter(
      mr =>
        mr.source_branch.startsWith(CMS_BRANCH_PREFIX) &&
        mr.labels.some(l => isCMSLabel(l, this.cmsLabelPrefix)),
    );
  }

  async listUnpublishedBranches() {
    console.log(
      '%c Checking for Unpublished entries',
      'line-height: 30px;text-align: center;font-weight: bold',
    );

    const pullRequests = await this.getPullRequests();
    const branches = pullRequests.map(mr => mr.source_branch);

    return branches;
  }

  async getFileId(path: string, branch: string) {
    const request = await this.request({
      method: 'HEAD',
      url: `${this.repoURL}/repository/files/${encodeURIComponent(path)}`,
      params: { ref: branch },
    });

    const blobId = request.headers.get('X-Gitlab-Blob-Id') as string;
    return blobId;
  }

  async isFileExists(path: string, branch: string) {
    const fileExists = await this.requestText({
      method: 'HEAD',
      url: `${this.repoURL}/repository/files/${encodeURIComponent(path)}`,
      params: { ref: branch },
    })
      .then(() => true)
      .catch(error => {
        if (error instanceof APIError && error.status === 404) {
          return false;
        }
        throw error;
      });

    return fileExists;
  }

  async getBranchPullRequest(branch: string) {
    const pulls = await this.getPullRequests(branch);
    if (pulls.length <= 0) {
      throw new EditorialWorkflowError('content is not under editorial workflow', true);
    }

    return pulls[0];
  }

  async getDifferences(to: string, from = this.branch) {
    if (to === from) {
      return [];
    }
    const result: { diffs: GiteaCommitDiff[] } = await this.requestJSON({
      url: `${this.repoURL}/repository/compare`,
      params: {
        from,
        to,
      },
    });

    if (result.diffs.length >= 1000) {
      throw new APIError('Diff limit reached', null, API_NAME);
    }

    return result.diffs.map(d => {
      let status = 'modified';
      if (d.new_file) {
        status = 'added';
      } else if (d.deleted_file) {
        status = 'deleted';
      } else if (d.renamed_file) {
        status = 'renamed';
      }
      return {
        status,
        oldPath: d.old_path,
        newPath: d.new_path,
        newFile: d.new_file,
        path: d.new_path || d.old_path,
        binary: d.diff.startsWith('Binary') || /.svg$/.test(d.new_path),
      };
    });
  }

  async retrieveUnpublishedEntryData(contentKey: string) {
    const { collection, slug } = parseContentKey(contentKey);
    const branch = branchFromContentKey(contentKey);
    const pullRequest = await this.getBranchPullRequest(branch);
    const diffs = await this.getDifferences(pullRequest.sha);
    const diffsWithIds = await Promise.all(
      diffs.map(async d => {
        const { path, newFile } = d;
        const id = await this.getFileId(path, branch);
        return { id, path, newFile };
      }),
    );
    const label = pullRequest.labels.find(l => isCMSLabel(l, this.cmsLabelPrefix)) as string;
    const status = labelToStatus(label, this.cmsLabelPrefix);
    const updatedAt = pullRequest.updated_at;
    return {
      collection,
      slug,
      status,
      diffs: diffsWithIds,
      updatedAt,
    };
  }

  async rebasePullRequest(pullRequest: GiteaPullRequest) {
    let rebase: GiteaMergeRebase = await this.requestJSON({
      method: 'PUT',
      url: `${this.repoURL}/pull/${pullRequest.iid}/rebase`,
    });

    let i = 1;
    while (rebase.rebase_in_progress) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      rebase = await this.requestJSON({
        url: `${this.repoURL}/pull/${pullRequest.iid}`,
        params: {
          include_rebase_in_progress: true,
        },
      });
      if (!rebase.rebase_in_progress || i > 10) {
        break;
      }
      i++;
    }

    if (rebase.rebase_in_progress) {
      throw new APIError('Timed out rebasing merge request', null, API_NAME);
    } else if (rebase.merge_error) {
      throw new APIError(`Rebase error: ${rebase.merge_error}`, null, API_NAME);
    }
  }

  async createPullRequest(branch: string, commitMessage: string, status: string) {
    await this.requestJSON({
      method: 'POST',
      url: `${this.repoURL}/pulls`,
      params: {
        source_branch: branch,
        target_branch: this.branch,
        title: commitMessage,
        description: DEFAULT_PR_BODY,
        labels: statusToLabel(status, this.cmsLabelPrefix),
        remove_source_branch: true,
        squash: this.squashMerges,
      },
    });
  }

  async editorialWorkflowGit(
    files: (DataFile | AssetProxy)[],
    slug: string,
    options: PersistOptions,
  ) {
    const contentKey = generateContentKey(options.collectionName as string, slug);
    const branch = branchFromContentKey(contentKey);
    const unpublished = options.unpublished || false;
    if (!unpublished) {
      const items = await this.getCommitItems(files, this.branch);
      await this.uploadAndCommit(items, {
        commitMessage: options.commitMessage,
        branch,
        newBranch: true,
      });
      await this.createPullRequest(
        branch,
        options.commitMessage,
        options.status || this.initialWorkflowStatus,
      );
    } else {
      const pullRequest = await this.getBranchPullRequest(branch);
      await this.rebasePullRequest(pullRequest);
      const [items, diffs] = await Promise.all([
        this.getCommitItems(files, branch),
        this.getDifferences(branch),
      ]);
      // mark files for deletion
      for (const diff of diffs.filter(d => d.binary)) {
        if (!items.some(item => item.path === diff.path)) {
          items.push({ action: CommitAction.DELETE, path: diff.newPath });
        }
      }

      await this.uploadAndCommit(items, {
        commitMessage: options.commitMessage,
        branch,
      });
    }
  }

  async updatePullRequestLabels(pullRequest: GiteaPullRequest, labels: string[]) {
    await this.requestJSON({
      method: 'PUT',
      url: `${this.repoURL}/pull/${pullRequest.iid}`,
      params: {
        labels: labels.join(','),
      },
    });
  }

  async updateUnpublishedEntryStatus(collection: string, slug: string, newStatus: string) {
    const contentKey = generateContentKey(collection, slug);
    const branch = branchFromContentKey(contentKey);
    const pullRequest = await this.getBranchPullRequest(branch);

    const labels = [
      ...pullRequest.labels.filter(label => !isCMSLabel(label, this.cmsLabelPrefix)),
      statusToLabel(newStatus, this.cmsLabelPrefix),
    ];
    await this.updatePullRequestLabels(pullRequest, labels);
  }

  async mergePullRequest(pullRequest: GiteaPullRequest) {
    await this.requestJSON({
      method: 'PUT',
      url: `${this.repoURL}/pull/${pullRequest.iid}/merge`,
      params: {
        merge_commit_message: MERGE_COMMIT_MESSAGE,
        squash_commit_message: MERGE_COMMIT_MESSAGE,
        squash: this.squashMerges,
        should_remove_source_branch: true,
      },
    });
  }

  async publishUnpublishedEntry(collectionName: string, slug: string) {
    const contentKey = generateContentKey(collectionName, slug);
    const branch = branchFromContentKey(contentKey);
    const pullRequest = await this.getBranchPullRequest(branch);
    await this.mergePullRequest(pullRequest);
  }

  async closePullRequest(pullRequest: GiteaPullRequest) {
    await this.requestJSON({
      method: 'PUT',
      url: `${this.repoURL}/pulll/${pullRequest.iid}`,
      params: {
        state_event: 'close',
      },
    });
  }

  async getDefaultBranch() {
    const branch: GiteaBranch = await this.getBranch(this.branch);
    return branch;
  }

  async isShaExistsInBranch(branch: string, sha: string) {
    const refs: GiteaCommitRef[] = await this.requestJSON({
      url: `${this.repoURL}/repository/commits/${sha}/refs`,
      params: {
        type: 'branch',
      },
    });
    return refs.some(r => r.name === branch);
  }

  async deleteBranch(branch: string) {
    await this.request({
      method: 'DELETE',
      url: `${this.repoURL}/repository/branches/${encodeURIComponent(branch)}`,
    });
  }

  async deleteUnpublishedEntry(collectionName: string, slug: string) {
    const contentKey = generateContentKey(collectionName, slug);
    const branch = branchFromContentKey(contentKey);
    const pullRequest = await this.getBranchPullRequest(branch);
    await this.closePullRequest(pullRequest);
    await this.deleteBranch(branch);
  }

  async getPullRequestStatues(pullRequest: GiteaPullRequest, branch: string) {
    const statuses: GiteaCommitStatus[] = await this.requestJSON({
      url: `${this.repoURL}/repository/commits/${pullRequest.sha}/statuses`,
      params: {
        ref: branch,
      },
    });
    return statuses;
  }

  async getStatuses(collectionName: string, slug: string) {
    const contentKey = generateContentKey(collectionName, slug);
    const branch = branchFromContentKey(contentKey);
    const pullRequest = await this.getBranchPullRequest(branch);
    const statuses: GiteaCommitStatus[] = await this.getPullRequestStatues(pullRequest, branch);
    return statuses.map(({ name, status, target_url }) => ({
      context: name,
      state: status === GiteaCommitStatuses.Success ? PreviewState.Success : PreviewState.Other,
      target_url,
    }));
  }

  async getUnpublishedEntrySha(collection: string, slug: string) {
    const contentKey = generateContentKey(collection, slug);
    const branch = branchFromContentKey(contentKey);
    const pullRequest = await this.getBranchPullRequest(branch);
    return pullRequest.sha;
  }
}
