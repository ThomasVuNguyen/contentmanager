import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { AllProvidersSettings } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/all.providers.settings';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import {
  ValidUrlExtension,
  ValidUrlPath,
} from '@gitroom/helpers/utils/valid.url.path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

const validUrlExtension = new ValidUrlExtension();
const validUrlPath = new ValidUrlPath();

const attachmentUrl = z
  .string()
  .refine((url) => validUrlPath.validate(url, {} as any), {
    message: validUrlPath.defaultMessage({} as any),
  })
  .refine((url) => validUrlExtension.validate(url, {} as any), {
    message: validUrlExtension.defaultMessage({} as any),
  });

@Injectable()
export class UpdatePostTool implements AgentToolInterface {
  constructor(private _postsService: PostsService) {}
  name = 'updatePostTool';

  run() {
    return createTool({
      id: 'updatePostTool',
      mcp: {
        annotations: {
          title: 'Update Existing Post or Draft',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      description: `
Update the content, media attachments, scheduled date, provider settings, or state of an existing draft or scheduled post (that was NOT published yet).
Find the post first using postsListTool to get its "id".
You can update:
- "content": New HTML/text content for the main post (wrap lines in <p> tags)
- "attachments": Array of image or video URLs to attach to the main post (from uploadFromUrlTool or generateImageTool)
- "postsAndComments": Optional array for threads or post + comment structure
- "date": Optional new publish date in UTC (e.g. 2026-08-25T14:00:00)
- "type": Optional new state: "draft" (keep/save as draft), "schedule" (schedule for publishing), or "now" (publish immediately)
- "settings": Optional provider settings to merge
`,
      inputSchema: z.object({
        id: z.string().describe('The post id of the draft or scheduled post to update'),
        content: z
          .string()
          .optional()
          .describe(
            "New content for the main post, HTML formatted (e.g. <p>text</p>)"
          ),
        attachments: z
          .array(attachmentUrl)
          .optional()
          .describe(
            'New image or video attachment URLs for the main post (must be hosted URLs, e.g. from uploadFromUrlTool or generateImageTool)'
          ),
        postsAndComments: z
          .array(
            z.object({
              content: z
                .string()
                .describe('The content of the post or comment (HTML)'),
              attachments: z
                .array(attachmentUrl)
                .describe('Attachment URLs for this post/comment'),
            })
          )
          .optional()
          .describe(
            'Optional array for threads or post + comments. First item is the main post, subsequent items are comments/thread posts.'
          ),
        date: z
          .string()
          .optional()
          .describe('New publish date in UTC time (e.g. 2026-08-25T14:00:00)'),
        type: z
          .enum(['draft', 'schedule', 'now'])
          .optional()
          .describe(
            'New state of the post: "draft", "schedule", or "now". If omitted, retains its current state.'
          ),
        shortLink: z
          .boolean()
          .optional()
          .describe('If the post has links, whether to convert them to short links'),
        settings: z
          .array(
            z.object({
              key: z.string().describe('Name of the settings key to change'),
              value: z
                .any()
                .describe('Value of the settings key'),
            })
          )
          .optional()
          .describe('Optional provider settings merged into existing settings'),
      }),
      outputSchema: z.object({
        output: z
          .object({
            postId: z.string(),
            publishDate: z.string(),
            state: z.string(),
            success: z.boolean().optional(),
          })
          .or(z.object({ errors: z.string() })),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = JSON.parse(
          (context?.requestContext as any)?.get('organization') as string
        ).id;

        try {
          const ordered = await this._postsService.getPostsRecursively(
            inputData.id,
            true,
            organizationId,
            true
          );

          const [root] = ordered;
          if (!root) {
            return { output: { errors: 'Post not found' } };
          }

          if (root.parentPostId) {
            return {
              output: {
                errors:
                  'This id belongs to a comment or thread reply. Please pass the id of the main post.',
              },
            };
          }

          if (root.state !== 'QUEUE' && root.state !== 'DRAFT') {
            return {
              output: {
                errors:
                  'Only scheduled posts that were not published yet (or drafts) can be updated.',
              },
            };
          }

          if (
            root.state === 'QUEUE' &&
            dayjs.utc(root.publishDate).isBefore(dayjs.utc())
          ) {
            return {
              output: {
                errors:
                  'The publish time of this post has already passed, it cannot be updated.',
              },
            };
          }

          const integration = (root as any).integration;

          let existingSettings: Record<string, any> = {};
          try {
            existingSettings = JSON.parse(root.settings || '{}');
          } catch (err) {
            existingSettings = {};
          }

          const passedSettings = (inputData.settings || []).reduce(
            (acc: Record<string, any>, s: { key: string; value: any }) => ({
              ...acc,
              [s.key]: s.value,
            }),
            {}
          );

          const mergedSettings = {
            ...existingSettings,
            ...passedSettings,
            __type: integration.providerIdentifier,
          } as AllProvidersSettings;

          let value: any[];
          if (inputData.postsAndComments?.length) {
            value = inputData.postsAndComments.map((p, idx) => {
              const existingChild = ordered[idx];
              return {
                id: existingChild?.id || makeId(10),
                content: p.content,
                delay: existingChild?.delay || 0,
                image: (p.attachments || []).map((path: string) => ({
                  id: makeId(10),
                  path,
                })),
              };
            });
          } else {
            value = ordered.map((p, idx) => {
              let image: any[] = [];
              try {
                image = JSON.parse(p.image || '[]');
              } catch (err) {}

              if (idx === 0) {
                return {
                  id: p.id,
                  content:
                    inputData.content !== undefined
                      ? inputData.content
                      : p.content,
                  delay: p.delay || 0,
                  image:
                    inputData.attachments !== undefined
                      ? inputData.attachments.map((path: string) => ({
                          id: makeId(10),
                          path,
                        }))
                      : image,
                };
              }

              return {
                id: p.id,
                content: p.content,
                delay: p.delay || 0,
                image,
              };
            });
          }

          const targetType =
            inputData.type || (root.state === 'DRAFT' ? 'draft' : 'schedule');

          const [validation] = await this._postsService.validatePosts(
            organizationId,
            [
              {
                integration: { id: integration.id },
                settings: mergedSettings,
                value: value.map((p) => ({
                  content: p.content,
                  image: p.image,
                })),
              },
            ]
          );

          if (validation.emptyContent) {
            return {
              output: {
                errors: `${validation.name}: Your post should have at least one character or one image.`,
              },
            };
          }

          if (targetType !== 'draft') {
            if (!validation.valid) {
              return {
                output: {
                  errors: `${validation.name}: ${
                    validation.settingsError || 'Please fix your settings'
                  }.`,
                },
              };
            }

            if (validation.errors !== true) {
              return {
                output: {
                  errors: `${validation.name}: ${validation.errors}.`,
                },
              };
            }

            if (validation.tooLong) {
              return {
                output: {
                  errors: `${validation.name}: The maximum characters is ${validation.maximumCharacters}.`,
                },
              };
            }
          }

          const publishDate =
            inputData.date ||
            dayjs.utc(root.publishDate).format('YYYY-MM-DDTHH:mm:ss');

          const tags = ((root as any).tags || []).map((t: any) => ({
            value: t.tag.name,
            label: t.tag.name,
          }));

          const [output] = await this._postsService.createPost(
            organizationId,
            {
              date: publishDate,
              type: targetType as 'draft' | 'schedule' | 'now',
              shortLink: inputData.shortLink ?? false,
              tags,
              posts: [
                {
                  integration,
                  group: root.group,
                  settings: mergedSettings,
                  value,
                },
              ],
            },
            'MCP',
            true // keepGroup
          );

          return {
            output: {
              postId: output?.postId || root.id,
              publishDate,
              state: targetType === 'draft' ? 'DRAFT' : 'QUEUE',
              success: true,
            },
          };
        } catch (err: any) {
          return {
            output: {
              errors: err?.message || 'Failed to update the post',
            },
          };
        }
      },
    });
  }
}
