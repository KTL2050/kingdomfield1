-- KTLSALES chat: private one-to-one chats + an "Everyone" group chat.
-- Run once in the Supabase SQL Editor BEFORE deploying ktl-chat.js.
-- Safe to run again: everything is "if not exists" / "on conflict do nothing".

-- One row per message.
--   conversation = 'all'                      → the Everyone group chat
--   conversation = 'dm:<lower id>:<higher id>' → a private chat between two users
create table if not exists public.chat_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation    text not null,
  sender_id       uuid not null,
  sender_name     text,
  recipient_id    uuid,                 -- null in the group chat
  body            text,
  attachment_path text,                 -- file in the chat-files bucket
  attachment_name text,
  attachment_type text,
  attachment_size integer,
  created_at      timestamptz not null default now(),
  constraint chat_message_not_empty
    check (coalesce(length(btrim(body)), 0) > 0 or attachment_path is not null)
);
create index if not exists chat_messages_conv_time      on public.chat_messages (conversation, created_at desc);
create index if not exists chat_messages_recipient_time on public.chat_messages (recipient_id, created_at desc);
create index if not exists chat_messages_sender_time    on public.chat_messages (sender_id, created_at desc);

-- How far each person has read each conversation: drives unread badges and "Seen".
-- last_read_at is the timestamp of the newest message they have seen (server time).
create table if not exists public.chat_reads (
  user_id      uuid not null,
  conversation text not null,
  last_read_at timestamptz not null,
  primary key (user_id, conversation)
);

-- Live updates: new messages and read receipts arrive instantly.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages') then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_reads') then
    alter publication supabase_realtime add table public.chat_reads;
  end if;
end $$;

-- Private bucket for photos and files (opened through short-lived signed links). 10 MB per file.
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 10485760)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
