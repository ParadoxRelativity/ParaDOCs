import { useState } from 'react';
import { channelName, type Channel } from '@paradocs/shared';
import { useUpdateChannel } from '../../api/hooks';
import { Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button } from '../ui';

const TOPIC_LENGTH = 200;

/**
 * A channel's name and topic. The topic is the line beside the name at the top
 * of the channel — "Everything else" on #general — so people know what belongs
 * there before they post.
 */
export function ChannelSettingsDialog({
  workspaceId,
  channel,
  onClose,
}: {
  workspaceId: string;
  channel: Channel;
  onClose: () => void;
}) {
  const update = useUpdateChannel(workspaceId);
  const toast = useToast();
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');

  // Names are addresses, so what is typed is shown the way it will be saved.
  const normalized = channelName(name);
  const nameChanged = normalized !== channel.name;
  const topicChanged = topic.trim() !== (channel.topic ?? '');
  const voice = channel.kind === 'voice';

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (!normalized || (!nameChanged && !topicChanged) || update.isPending) return;
    try {
      await update.mutateAsync({
        id: channel.id,
        ...(nameChanged ? { name: normalized } : {}),
        ...(topicChanged ? { topic: topic.trim() || null } : {}),
      });
      toast(voice ? 'Voice channel updated' : `#${normalized} updated`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the channel', 'error');
    }
  }

  return (
    <Modal
      title={voice ? `${channel.name} settings` : `#${channel.name} settings`}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="text-xs"
            onClick={() => void save()}
            disabled={!normalized || (!nameChanged && !topicChanged) || update.isPending}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--color-muted)]">Name</span>
          <input
            autoFocus
            className={FIELD}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            aria-describedby="channel-name-hint"
          />
          <span id="channel-name-hint" className="mt-1 block text-xs text-[var(--color-muted)]">
            {normalized
              ? normalized !== name.trim()
                ? `Saved as ${voice ? '' : '#'}${normalized}`
                : 'Lowercase letters, numbers and dashes.'
              : 'Use letters or numbers.'}
          </span>
        </label>

        <label className="block">
          <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-muted)]">
            <span>Topic</span>
            <span>
              {topic.length}/{TOPIC_LENGTH}
            </span>
          </span>
          <input
            className={FIELD}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            maxLength={TOPIC_LENGTH}
            placeholder={voice ? 'Drop in to talk' : 'What this channel is for'}
          />
          <span className="mt-1 block text-xs text-[var(--color-muted)]">
            Shown beside the name at the top of the channel. Leave it empty for none.
          </span>
        </label>
        {/* Enter in either field saves. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
