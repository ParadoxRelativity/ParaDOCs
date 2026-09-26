# Intake webhook

Queues can take in work from outside ParaDOCs — a web form, a monitoring alert,
another system — through one webhook for the whole server:

```
POST $PUBLIC_URL/api/intake
```

The token sent with each request says which queue the work goes to. A queue can
have several tokens, one per form or sender, and each can be revoked on its own.

## Turning it on

The webhook is off by default. While it is off, `/api/intake` answers 404 and
no token does anything.

1. On the admin page, under **Server settings**, turn on **Intake webhook**.
2. In a queue, open **Settings → Intake** and make a token. Name it after what
   will use it, such as "Support form". You need the right to configure the
   queue.
3. Copy the token. It is shown once; only its hash is stored. If it is lost,
   revoke it and make another.

Each token can be set to file what it sends in as one of the queue's types.
Otherwise the queue's default type is used.

## Sending work in

Send the token as a bearer token:

```sh
curl -X POST https://paradocs.example.com/api/intake \
  -H 'Authorization: Bearer pdi_…' \
  -H 'Content-Type: application/json' \
  -d '{"title": "Printer on 3rd floor is jammed", "requester": "Jane Doe", "priority": "high"}'
```

A plain HTML form can't set headers, so it sends the token in a field named
`token` instead. The body can be JSON or form-encoded:

```html
<form method="post" action="https://paradocs.example.com/api/intake">
  <input type="hidden" name="token" value="pdi_…">
  <input name="title" required>
  <input name="email" type="email">
  <textarea name="description"></textarea>
  <button>Send</button>
</form>
```

A browser that posts a form gets a short "Thank you" page back. Everything else
gets JSON: `201 {"id": "…", "key": "HELP-12"}`. The webhook allows cross-origin
requests from any origin, without credentials, so a script on another site can
call it too.

| Field         | Meaning                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `title`       | Required. `subject` or `summary` also work.                                                                                   |
| `description` | `body`, `message` or `details` also work.                                                                                     |
| `priority`    | `none`, `low`, `medium`, `high` or `urgent`.                                                                                  |
| `requester`   | Who asked. Goes in the queue's free-form role (Requester by default). `name` or `email` also work.                            |
| `type`        | The name of one of the queue's types, such as `Bug`. The token's type is used if you leave it out.                             |
| `dueDate`     | `YYYY-MM-DD`.                                                                                                                 |

Any other field is kept and listed under the description as `Field: value`, so a
form's other questions are not lost. Fields with repeated names, such as a group
of checkboxes, are joined with commas.

New work starts in the queue's first status. In the item's history it shows as
sent in through the token, by the token's name.

## Limits and safety

- A token can only create work items in its own queue. It cannot read anything.
- A token in a public web page can be read by anyone who views that page. Treat
  such a token as public and revoke it if the queue starts getting spam.
- Each token can send in 60 items a minute. An address that sends 20 wrong tokens
  is refused for 15 minutes.
- Bodies over 256 KB are refused. Descriptions are cut off at 20,000 characters.
- Reference syntax in what is sent in (`<@…>`, `<doc:…>` and so on) is left as
  plain text, so a sender can't mention people or link documents.
- Archived queues, and workspaces with Projects turned off, refuse new work.
