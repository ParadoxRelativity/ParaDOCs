import { useState } from 'react';
import {
  MAX_DIRECT_PEOPLE,
  directName,
  directPeople,
  isGroupDirect,
  type Channel,
  type PresenceStatus,
} from '@paradocs/shared';
import { useAddDirectMembers, useOpenDirect, useRemoveDirectMember, useRenameDirect } from '../../api/hooks';
import Avatar from '../Avatar';
import Icon from '../Icon';
import { ConfirmDialog, Modal } from '../Modal';
import { FIELD, Section } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton } from '../ui';
import { DirectMessageDialog } from './DirectMessageDialog';

interface Self {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * The people in a direct conversation, from its header.
 *
 * In a group this opens its settings: its name, who is in it, adding and
 * removing people, and leaving. Between two people it offers to add someone,
 * which starts a group rather than opening this conversation up — what two
 * people said to each other stays between them.
 */
export function DirectPeopleButton({
  workspaceId,
  channel,
  self,
  presence,
  onOpenConversation,
  onLeft,
}: {
  workspaceId: string;
  channel: Channel;
  self: Self;
  presence: Record<string, PresenceStatus>;
  /** Shows a conversation just started from this one. */
  onOpenConversation: (channelId: string) => void;
  /** Called once you have left, since this conversation is gone from your list. */
  onLeft?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const openDirect = useOpenDirect(workspaceId);
  const toast = useToast();
  const group = isGroupDirect(channel);
  const peer = directPeople(channel)[0];

  // A conversation whose other person's account is gone has no one to add to.
  if (!group && !peer) return null;

  async function startGroup(userIds: string[]) {
    setOpen(false);
    try {
      const conversation = await openDirect.mutateAsync([peer!.id, ...userIds]);
      onOpenConversation(conversation.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the conversation', 'error');
    }
  }

  return (
    <>
      <IconButton label={group ? 'People and settings' : 'Add people'} onClick={() => setOpen(true)}>
        <Icon name={group ? 'people' : 'person-plus'} />
      </IconButton>
      {open &&
        (group ? (
          <GroupDialog
            workspaceId={workspaceId}
            channel={channel}
            self={self}
            presence={presence}
            onLeft={() => {
              setOpen(false);
              onLeft?.();
            }}
            onClose={() => setOpen(false)}
          />
        ) : (
          <DirectMessageDialog
            workspaceId={workspaceId}
            presence={presence}
            title="Start a group"
            excludeIds={[peer!.id]}
            capacity={MAX_DIRECT_PEOPLE - 2}
            actionLabel={(count) => (count > 0 ? `Start a group of ${count + 2}` : 'Start a group')}
            note={`This starts a new conversation. What you and ${peer!.name} have said stays between you.`}
            onChoose={(userIds) => void startGroup(userIds)}
            onClose={() => setOpen(false)}
          />
        ))}
    </>
  );
}

function GroupDialog({
  workspaceId,
  channel,
  self,
  presence,
  onLeft,
  onClose,
}: {
  workspaceId: string;
  channel: Channel;
  self: Self;
  presence: Record<string, PresenceStatus>;
  onLeft: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const rename = useRenameDirect(workspaceId);
  const add = useAddDirectMembers(workspaceId);
  const remove = useRemoveDirectMember(workspaceId);
  const [name, setName] = useState(channel.name);
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const others = directPeople(channel);
  const count = others.length + 1;
  const full = count >= MAX_DIRECT_PEOPLE;
  // What it is called without a name of its own.
  const fallback = directName({ ...channel, name: '' });
  const fail = (err: Error) => toast(err.message, 'error');

  function saveName() {
    rename.mutate(
      { channelId: channel.id, name: name.trim() },
      { onSuccess: () => toast(name.trim() ? 'Conversation renamed' : 'Name removed'), onError: fail },
    );
  }

  return (
    <Modal
      title={directName(channel)}
      description={`${count} ${count === 1 ? 'person' : 'people'}`}
      // Escape belongs to whichever dialog is on top.
      onClose={adding || leaving ? () => {} : onClose}
      footer={
        <>
          <Button variant="danger" className="mr-auto text-xs" onClick={() => setLeaving(true)}>
            <Icon name="box-arrow-left" /> Leave
          </Button>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <Section title="Name" hint="Everyone in the conversation sees it. Leave it empty to name it for its people.">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() !== channel.name) saveName();
          }}
        >
          <input
            className={FIELD}
            value={name}
            maxLength={80}
            placeholder={fallback}
            aria-label="Conversation name"
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            variant="primary"
            type="submit"
            className="shrink-0 text-xs"
            disabled={name.trim() === channel.name || rename.isPending}
          >
            Save
          </Button>
        </form>
      </Section>

      <Section title="People">
        <ul className="scroll-thin -mx-1 max-h-64 overflow-y-auto px-1">
          <li className="flex items-center gap-2.5 py-1.5">
            <Avatar name={self.name} url={self.avatarUrl} seed={self.id} size="lg" />
            <span className="min-w-0 flex-1 truncate text-sm">
              {self.name} <span className="text-[var(--color-muted)]">(you)</span>
            </span>
          </li>
          {others.map((person) => (
            <li key={person.id} className="flex items-center gap-2.5 py-1.5">
              <Avatar name={person.name} url={person.avatarUrl} seed={person.id} size="lg" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{person.name}</span>
                <span className="block truncate text-[11px] text-[var(--color-muted)]">{person.email}</span>
              </span>
              <Button
                variant="subtle"
                className="shrink-0 text-xs"
                // Someone has to be left to talk to; with one other, leaving is the way out.
                disabled={count <= 2 || remove.isPending}
                title={count <= 2 ? 'A group needs at least two people' : undefined}
                onClick={() =>
                  remove.mutate(
                    { channelId: channel.id, userId: person.id },
                    { onSuccess: () => toast(`Removed ${person.name}`), onError: fail },
                  )
                }
              >
                <Icon name="person-dash" /> Remove
              </Button>
            </li>
          ))}
        </ul>
        <Button
          variant="subtle"
          className="mt-2 text-xs"
          disabled={full || add.isPending}
          title={full ? `A conversation can have up to ${MAX_DIRECT_PEOPLE} people` : undefined}
          onClick={() => setAdding(true)}
        >
          <Icon name="person-plus" /> Add people
        </Button>
      </Section>

      {adding && (
        <DirectMessageDialog
          workspaceId={workspaceId}
          presence={presence}
          title="Add people"
          excludeIds={others.map((person) => person.id)}
          capacity={MAX_DIRECT_PEOPLE - count}
          actionLabel={(picked) => (picked > 1 ? `Add ${picked} people` : 'Add')}
          note="They will be able to read everything already said here."
          onChoose={(userIds) => {
            setAdding(false);
            add.mutate(
              { channelId: channel.id, userIds },
              {
                onSuccess: () => toast(userIds.length === 1 ? 'Added 1 person' : `Added ${userIds.length} people`),
                onError: fail,
              },
            );
          }}
          onClose={() => setAdding(false)}
        />
      )}

      {leaving && (
        <ConfirmDialog
          title="Leave this conversation?"
          description={
            count === 1
              ? 'No one else is in it, so it is deleted, with everything said and shared in it.'
              : 'It is removed from your list and you stop getting its messages. Someone still in it can add you back.'
          }
          confirmLabel="Leave"
          onConfirm={() => {
            setLeaving(false);
            remove.mutate({ channelId: channel.id, userId: self.id }, { onSuccess: onLeft, onError: fail });
          }}
          onCancel={() => setLeaving(false)}
        />
      )}
    </Modal>
  );
}
