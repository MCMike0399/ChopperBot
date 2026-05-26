import { describe, test, expect } from 'vitest';
import type { Client, Message } from 'discord.js';
import { shouldRespond, stripBotMention } from '../handlers.js';

const BOT_ID = '999999999999999999';
const CHANNEL = '12345678901234567890';

function makeClient(): Client {
  return { user: { id: BOT_ID } } as unknown as Client;
}

interface MsgOverrides {
  authorBot?: boolean;
  channelId?: string;
  mentioned?: boolean;
  isReplyToBot?: boolean;
  refId?: string;
}

function makeMessage(o: MsgOverrides = {}): Message {
  return {
    author: { bot: o.authorBot ?? false },
    channelId: o.channelId ?? CHANNEL,
    mentions: {
      users: { has: (id: string) => (o.mentioned ? id === BOT_ID : false) },
      repliedUser: o.isReplyToBot ? { id: BOT_ID } : null,
    },
    reference: o.refId ? { messageId: o.refId } : null,
  } as unknown as Message;
}

describe('shouldRespond (live authorized-channel set is passed in per call)', () => {
  test('responds to an @mention from a human in an authorized channel', () => {
    expect(
      shouldRespond(makeClient(), makeMessage({ mentioned: true }), new Set([CHANNEL])),
    ).toBe(true);
  });

  test('responds to a reply where repliedUser is the bot', () => {
    expect(
      shouldRespond(
        makeClient(),
        makeMessage({ isReplyToBot: true, refId: '1' }),
        new Set([CHANNEL]),
      ),
    ).toBe(true);
  });

  test('ignores messages from other bots', () => {
    expect(
      shouldRespond(
        makeClient(),
        makeMessage({ mentioned: true, authorBot: true }),
        new Set([CHANNEL]),
      ),
    ).toBe(false);
  });

  test('ignores messages in unauthorized channels', () => {
    expect(
      shouldRespond(
        makeClient(),
        makeMessage({ mentioned: true, channelId: '00000000000000001' }),
        new Set([CHANNEL]),
      ),
    ).toBe(false);
  });

  test('responds in any authorized channel (multi-channel)', () => {
    const auth = new Set(['11111111111111111111', '22222222222222222222', '33333333333333333333']);
    expect(
      shouldRespond(
        makeClient(),
        makeMessage({ mentioned: true, channelId: '22222222222222222222' }),
        auth,
      ),
    ).toBe(true);
    expect(
      shouldRespond(
        makeClient(),
        makeMessage({ mentioned: true, channelId: '33333333333333333333' }),
        auth,
      ),
    ).toBe(true);
  });

  test('denies all when no channels configured', () => {
    expect(
      shouldRespond(makeClient(), makeMessage({ mentioned: true }), new Set()),
    ).toBe(false);
  });

  test('ignores messages with no mention and no reply', () => {
    expect(shouldRespond(makeClient(), makeMessage(), new Set([CHANNEL]))).toBe(false);
  });

  test('returns false if the client has no user yet', () => {
    const c = { user: null } as unknown as Client;
    expect(shouldRespond(c, makeMessage({ mentioned: true }), new Set([CHANNEL]))).toBe(false);
  });

  test('newly added bindings take effect immediately (the same call gets a different auth set)', () => {
    const auth = new Set<string>();
    expect(shouldRespond(makeClient(), makeMessage({ mentioned: true }), auth)).toBe(false);
    auth.add(CHANNEL);
    expect(shouldRespond(makeClient(), makeMessage({ mentioned: true }), auth)).toBe(true);
  });
});

describe('stripBotMention', () => {
  test('strips the canonical mention pattern', () => {
    expect(stripBotMention(makeClient(), `hello <@${BOT_ID}> there`)).toBe('hello  there');
  });
  test('strips the nickname mention pattern', () => {
    expect(stripBotMention(makeClient(), `<@!${BOT_ID}> ping`)).toBe(' ping');
  });
  test('leaves other mentions alone', () => {
    expect(stripBotMention(makeClient(), '<@111> hi')).toBe('<@111> hi');
  });
  test('returns content unchanged when client has no user', () => {
    const c = { user: null } as unknown as Client;
    expect(stripBotMention(c, '<@999> x')).toBe('<@999> x');
  });
});
