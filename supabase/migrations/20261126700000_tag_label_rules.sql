-- ============================================================================
-- 20261126700000_tag_label_rules
--
-- Cleaner auto-tag suggestions, approved by Saj 2026-11-26. Google Vision
-- labels are often textbook words nobody searches for ("carnivores",
-- "vertebrate", "snout") or a latin family where a plain word exists
-- ("canidae" -> "dog"). Admins now tune this in fame-admin instead of a
-- hard-coded list in the media pipeline:
--
--   drop    the label is never suggested
--   rename  the label is suggested as rename_to instead (deduped, so
--           "canidae" + "dog" on one photo give a single "dog")
--
-- The media-pipeline edge function reads active rules with the service role
-- (cached briefly per isolate) and applies them to every vision label and
-- landmark before suggestions reach the app. Rules only shape SUGGESTIONS:
-- tags already on posts are untouched.
--
-- Access: service role only (pipeline + fame-admin). No client grants —
-- the list is moderation tuning, not something the app reads.
-- ============================================================================

set search_path = public, extensions;

create table public.tag_label_rules (
  id         uuid primary key default gen_random_uuid(),
  label      text not null unique
               check (label = lower(btrim(label)) and label <> ''),
  action     text not null check (action in ('drop', 'rename')),
  rename_to  text check (rename_to is null or (rename_to = lower(btrim(rename_to)) and rename_to <> '')),
  note       text,
  active     boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  constraint tag_label_rules_rename_target
    check ((action = 'rename') = (rename_to is not null)),
  constraint tag_label_rules_not_self
    check (rename_to is distinct from label)
);
alter table public.tag_label_rules enable row level security;
revoke all on table public.tag_label_rules from public, anon, authenticated;
grant select, insert, update, delete on table public.tag_label_rules to service_role;

-- Seeds: labels Google returns a lot that carry no discovery value, seen on
-- real uploads (dog, travel and nature photos) plus their obvious siblings.
insert into public.tag_label_rules (label, action, rename_to, note) values
  -- Animal taxonomy / anatomy
  ('carnivores',               'drop',   null,       'taxonomy'),
  ('carnivore',                'drop',   null,       'taxonomy'),
  ('vertebrate',               'drop',   null,       'taxonomy'),
  ('mammal',                   'drop',   null,       'taxonomy'),
  ('organism',                 'drop',   null,       'taxonomy'),
  ('terrestrial animal',       'drop',   null,       'taxonomy'),
  ('working animal',           'drop',   null,       'taxonomy'),
  ('sporting group',           'drop',   null,       'kennel-club group'),
  ('toy dog',                  'drop',   null,       'kennel-club group'),
  ('snout',                    'drop',   null,       'anatomy'),
  ('whiskers',                 'drop',   null,       'anatomy'),
  ('fur',                      'drop',   null,       'anatomy'),
  ('canidae',                  'rename', 'dog',      'latin family'),
  ('companion dog',            'rename', 'dog',      'plain word'),
  ('dog breed',                'rename', 'dog',      'plain word'),
  ('mountain dog',             'rename', 'dog',      'plain word'),
  ('dog supply',               'rename', 'pets',     'plain word'),
  ('pet supply',               'rename', 'pets',     'plain word'),
  ('felidae',                  'rename', 'cat',      'latin family'),
  ('small to medium-sized cats','rename','cat',      'plain word'),
  -- Plant / landscape textbook words
  ('plant',                    'drop',   null,       'too generic'),
  ('botany',                   'drop',   null,       'textbook'),
  ('terrestrial plant',        'drop',   null,       'textbook'),
  ('plant community',          'drop',   null,       'textbook'),
  ('groundcover',              'drop',   null,       'textbook'),
  ('twig',                     'drop',   null,       'too specific'),
  ('trunk',                    'drop',   null,       'too specific'),
  ('branch',                   'drop',   null,       'too specific'),
  ('shade',                    'drop',   null,       'lighting, not a subject'),
  ('plain',                    'drop',   null,       'ambiguous'),
  ('woody plant',              'rename', 'tree',     'plain word'),
  ('natural landscape',        'rename', 'landscape','plain word'),
  ('natural environment',      'rename', 'nature',   'plain word'),
  ('body of water',            'rename', 'water',    'plain word'),
  ('water resources',          'rename', 'water',    'plain word'),
  ('watercourse',              'rename', 'river',    'plain word'),
  ('fluvial landforms of streams','rename','river',  'plain word'),
  ('cumulus',                  'rename', 'clouds',   'plain word'),
  ('ancient history',          'rename', 'history',  'plain word'),
  ('historic site',            'rename', 'history',  'plain word'),
  ('tourism',                  'rename', 'travel',   'plain word'),
  ('tourist attraction',       'rename', 'travel',   'plain word'),
  ('landmark',                 'drop',   null,       'landmark detection names the actual place'),
  -- Colour / light / abstract
  ('tints and shades',         'drop',   null,       'abstract'),
  ('azure',                    'drop',   null,       'colour'),
  ('electric blue',            'drop',   null,       'colour'),
  ('blue',                     'drop',   null,       'colour'),
  ('colorfulness',             'drop',   null,       'abstract'),
  ('atmosphere',               'drop',   null,       'abstract'),
  ('atmospheric phenomenon',   'drop',   null,       'abstract'),
  ('darkness',                 'drop',   null,       'abstract'),
  ('pattern',                  'drop',   null,       'abstract'),
  ('symmetry',                 'drop',   null,       'abstract'),
  ('parallel',                 'drop',   null,       'abstract'),
  ('event',                    'drop',   null,       'abstract'),
  ('fun',                      'drop',   null,       'abstract'),
  ('leisure',                  'drop',   null,       'abstract'),
  ('recreation',               'drop',   null,       'abstract'),
  ('happy',                    'drop',   null,       'abstract'),
  ('comfort',                  'drop',   null,       'abstract'),
  ('flash photography',        'drop',   null,       'camera technique'),
  -- Devices (screenshots, phones in shot)
  ('display device',           'drop',   null,       'screenshot artefact'),
  ('technology',               'drop',   null,       'screenshot artefact'),
  ('mobile phone',             'drop',   null,       'screenshot artefact'),
  ('electronic device',        'drop',   null,       'screenshot artefact'),
  ('gadget',                   'drop',   null,       'screenshot artefact'),
  ('communication device',     'drop',   null,       'screenshot artefact'),
  ('portable communication device','drop',null,      'screenshot artefact'),
  ('multimedia',               'drop',   null,       'screenshot artefact'),
  ('output device',            'drop',   null,       'screenshot artefact'),
  ('number',                   'drop',   null,       'screenshot artefact'),
  -- Body parts (people photos)
  ('gesture',                  'drop',   null,       'anatomy'),
  ('finger',                   'drop',   null,       'anatomy'),
  ('thumb',                    'drop',   null,       'anatomy'),
  ('hand',                     'drop',   null,       'anatomy'),
  ('nail',                     'drop',   null,       'anatomy'),
  ('jaw',                      'drop',   null,       'anatomy'),
  ('neck',                     'drop',   null,       'anatomy'),
  ('chin',                     'drop',   null,       'anatomy'),
  ('forehead',                 'drop',   null,       'anatomy'),
  ('eyebrow',                  'drop',   null,       'anatomy'),
  ('eyelash',                  'drop',   null,       'anatomy'),
  ('lip',                      'drop',   null,       'anatomy'),
  ('nose',                     'drop',   null,       'anatomy'),
  ('cheek',                    'drop',   null,       'anatomy'),
  ('ear',                      'drop',   null,       'anatomy'),
  ('skin',                     'drop',   null,       'anatomy'),
  ('sleeve',                   'drop',   null,       'clothing detail'),
  ('headgear',                 'drop',   null,       'clothing detail'),
  ('eyewear',                  'drop',   null,       'clothing detail'),
  -- Building / interior / vehicle parts
  ('plank',                    'drop',   null,       'material'),
  ('hardwood',                 'drop',   null,       'material'),
  ('wood stain',               'drop',   null,       'material'),
  ('varnish',                  'drop',   null,       'material'),
  ('flooring',                 'drop',   null,       'material'),
  ('floor',                    'drop',   null,       'material'),
  ('tile flooring',            'drop',   null,       'material'),
  ('textile',                  'drop',   null,       'material'),
  ('linens',                   'drop',   null,       'material'),
  ('facade',                   'drop',   null,       'building detail'),
  ('window',                   'drop',   null,       'building detail'),
  ('real estate',              'drop',   null,       'not a subject'),
  ('property',                 'drop',   null,       'not a subject'),
  ('residential area',         'drop',   null,       'not a subject'),
  ('interior design',          'drop',   null,       'not a subject'),
  ('furniture',                'drop',   null,       'too generic'),
  ('automotive design',        'drop',   null,       'vehicle detail'),
  ('automotive exterior',      'drop',   null,       'vehicle detail'),
  ('vehicle door',             'drop',   null,       'vehicle detail'),
  ('head restraint',           'drop',   null,       'vehicle detail'),
  ('car seat',                 'drop',   null,       'vehicle detail'),
  ('motor vehicle',            'rename', 'car',      'plain word'),
  ('couch',                    'rename', 'sofa',     'UK English'),
  ('studio couch',             'rename', 'sofa',     'UK English');
