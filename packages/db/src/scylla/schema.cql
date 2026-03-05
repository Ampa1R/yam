-- YAM ScyllaDB Schema
-- Run against keyspace 'yam'

CREATE TYPE IF NOT EXISTS yam.attachment (
    type      tinyint,
    url       text,
    filename  text,
    size      int,
    mime_type text,
    width     smallint,
    height    smallint,
    duration  smallint,
    waveform  blob
);

CREATE TABLE IF NOT EXISTS yam.messages (
    chat_id        uuid,
    bucket         int,
    id             timeuuid,
    sender_id      uuid,
    type           tinyint,
    content        text,
    attachments    list<frozen<yam.attachment>>,
    media_group_id uuid,
    reply_to       timeuuid,
    is_edited      boolean,
    is_deleted     boolean,
    created_at     timestamp,
    edited_at      timestamp,
    PRIMARY KEY ((chat_id, bucket), id)
) WITH CLUSTERING ORDER BY (id DESC)
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_size': 7,
    'compaction_window_unit': 'DAYS'
  }
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS yam.message_status (
    chat_id    uuid,
    message_id timeuuid,
    user_id    uuid,
    status     tinyint,
    updated_at timestamp,
    PRIMARY KEY ((chat_id, message_id), user_id)
);

CREATE TABLE IF NOT EXISTS yam.user_inbox (
    user_id          uuid,
    chat_id          uuid,
    chat_type        tinyint,
    chat_name        text,
    chat_avatar      text,
    other_user_id    uuid,
    last_msg_sender  uuid,
    last_msg_type    tinyint,
    last_msg_preview text,
    last_activity    timestamp,
    unread_count     int,
    is_pinned        boolean,
    is_muted         boolean,
    PRIMARY KEY (user_id, chat_id)
);
