"""Ready-made habits to start from. Each can be edited after it's added.

Chosen to be small, specific and safe. Nothing here restricts food, counts
calories or rewards going without sleep; a habit app that nudges people
towards eating less is doing harm, whatever the intention. Break-a-habit
templates are framed as practice, not purity: a slip is logged, not punished.

Targets are deliberately modest. Starting small and building is what the
habit research keeps finding works; anyone can raise a target later.
"""

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Template:
    id: str
    name: str
    emoji: str
    category: str
    kind: str  # check | duration | count | quit
    blurb: str
    unit: str | None = None
    daily_goal: float | None = None
    weekly_target: int = 7
    time_of_day: str = "anytime"
    cue: str | None = None
    total_goal: float | None = None


CATEGORIES = {
    "health": "Health",
    "fitness": "Movement",
    "learning": "Learning & skills",
    "mind": "Mind",
    "social": "People",
    "productivity": "Focus",
    "money": "Money",
    "home": "Home",
    "creative": "Creative",
    "break": "Breaking a habit",
    "other": "Other",
}

T = Template
# fmt: off
TEMPLATES: tuple[Template, ...] = (
    # Health
    T('sleep-7', "Seven hours' sleep", '😴', 'health', 'check', 'Most adults need seven or more. Tick it when you got there.', time_of_day='morning'),
    T('bedtime', 'In bed by a set time', '🛏️', 'health', 'check', 'A regular bedtime does more for sleep than a regular alarm.', cue='When my evening alarm goes', time_of_day='evening'),
    T('water', 'Drink water', '💧', 'health', 'count', 'A glass with each meal and a few between.', unit='glasses', daily_goal=6),
    T('veg', 'Vegetables with two meals', '🥦', 'health', 'check', "Add, don't restrict: more plants, nothing taken away.", weekly_target=5),
    T('cook', 'Cook at home', '🍳', 'health', 'check', 'Even something simple counts.', weekly_target=4, time_of_day='evening'),
    T('vitamins', 'Take medication or vitamins', '💊', 'health', 'check', 'Tie it to something you already do every day.', cue='After I brush my teeth', time_of_day='morning'),
    T('floss', 'Floss', '🦷', 'health', 'check', 'Two minutes, one of the best-evidenced habits there is.', cue='After I brush my teeth', time_of_day='evening'),
    T('sunlight', 'Morning daylight', '🌅', 'health', 'duration', 'Ten minutes outside soon after waking helps set your body clock.', unit='minutes', daily_goal=10, weekly_target=5, time_of_day='morning'),
    T('outdoors', 'Time outdoors', '🌳', 'health', 'duration', 'Green space, any weather.', unit='minutes', daily_goal=20, weekly_target=5),
    T('posture', 'Posture check', '🪑', 'health', 'check', 'Stand, stretch, reset every hour or so.', weekly_target=5, time_of_day='afternoon'),
    T('sunscreen', 'Sunscreen', '🧴', 'health', 'check', "Every day it's light out.", time_of_day='morning'),
    T('skincare', 'Skincare routine', '🧼', 'health', 'check', 'Morning or night, whatever you do.', time_of_day='evening'),
    # Movement
    T('steps', 'Walk 7,000 steps', '👣', 'fitness', 'check', 'Around where the health benefits of walking level off for many people.', weekly_target=5),
    T('stretch', 'Stretch', '🤸', 'fitness', 'duration', 'Ten minutes, anywhere.', unit='minutes', daily_goal=10, weekly_target=5),
    T('stairs', 'Take the stairs', '🪜', 'fitness', 'check', "Every time there's a choice.", weekly_target=5),
    T('mobility', 'Mobility routine', '🧘', 'fitness', 'duration', 'Hips, shoulders, spine.', unit='minutes', daily_goal=10, weekly_target=4),
    T('pushups', 'Push-ups', '💪', 'fitness', 'count', 'A few sets through the day add up.', unit='reps', daily_goal=20, weekly_target=5),
    # Learning & skills
    T('read', 'Read', '📚', 'learning', 'count', 'Pages of anything you chose to read.', unit='pages', daily_goal=10, cue='When I get into bed', time_of_day='evening'),
    T('language', 'Practise a language', '🗣️', 'learning', 'duration', 'Little and often beats a long weekly session.', unit='minutes', daily_goal=15, total_goal=6000, weekly_target=6),
    T('instrument', 'Practise an instrument', '🎸', 'learning', 'duration', 'Focused practice on the hard bars, not just playing through.', unit='minutes', daily_goal=20, total_goal=6000, weekly_target=5),
    T('code', 'Practise coding', '💻', 'learning', 'duration', 'Build something small, or work through an exercise.', unit='minutes', daily_goal=30, total_goal=6000, weekly_target=5),
    T('course', 'Course lesson', '🎓', 'learning', 'check', "One lesson of whatever you're studying.", weekly_target=4),
    T('flashcards', 'Review flashcards', '🃏', 'learning', 'check', 'Spaced repetition works best done daily, even briefly.'),
    T('write', 'Write', '✍️', 'learning', 'count', 'Fiction, essays, a blog: words on the page.', unit='words', daily_goal=300, weekly_target=5),
    # Creative
    T('draw', 'Draw or sketch', '🎨', 'creative', 'duration', 'Fifteen minutes with a pencil.', unit='minutes', daily_goal=15, weekly_target=4),
    T('photo', 'Take one good photo', '📷', 'creative', 'check', 'Look properly at one thing a day.'),
    T('craft', 'Make something', '🧶', 'creative', 'duration', 'Knit, build, fix, sew.', unit='minutes', daily_goal=20, weekly_target=3),
    # Learning & skills
    T('podcast', 'Learn from a podcast or talk', '🎧', 'learning', 'check', 'One episode with something new in it.', weekly_target=3),
    T('typing', 'Typing practice', '⌨️', 'learning', 'duration', 'Ten minutes of drills.', unit='minutes', daily_goal=10, weekly_target=5),
    T('chess', 'Chess puzzles', '♟️', 'learning', 'count', 'A few tactics a day.', unit='puzzles', daily_goal=5),
    # Mind
    T('meditate', 'Meditate', '🧘', 'mind', 'duration', 'Even five minutes counts.', unit='minutes', daily_goal=5, cue='After I make coffee', time_of_day='morning'),
    T('journal', 'Journal', '📓', 'mind', 'check', 'A few lines about the day.', time_of_day='evening'),
    T('gratitude', 'Three good things', '🙏', 'mind', 'check', 'Write down three things that went well, and why.', time_of_day='evening'),
    T('breathe', 'Breathing exercise', '🌬️', 'mind', 'duration', 'Slow breathing, a few minutes at a time.', unit='minutes', daily_goal=3),
    T('screen-sunset', 'No screens the hour before bed', '🌙', 'mind', 'check', 'Swap it for a book or a chat.', weekly_target=5, time_of_day='evening'),
    T('offline', 'Time offline', '📵', 'mind', 'duration', 'An hour with the phone in another room.', unit='minutes', daily_goal=60, weekly_target=5),
    T('walk-think', 'A walk without headphones', '🚶', 'mind', 'check', 'Let your mind wander.', weekly_target=3),
    # People
    T('call', 'Call someone you care about', '📞', 'social', 'check', 'Family or a friend. A voice beats a message.', weekly_target=2),
    T('kindness', 'One kind thing', '💛', 'social', 'check', 'For anyone, however small.'),
    T('family-meal', 'Eat together', '🍽️', 'social', 'check', 'No phones at the table.', weekly_target=4, time_of_day='evening'),
    T('play', 'Play with the kids', '🧸', 'social', 'duration', 'Their game, their rules.', unit='minutes', daily_goal=20, weekly_target=5),
    # Focus
    T('plan-day', 'Plan tomorrow', '🗒️', 'productivity', 'check', 'Three things that matter, written down tonight.', weekly_target=5, time_of_day='evening'),
    T('deep-work', 'Deep work', '🎯', 'productivity', 'duration', 'Uninterrupted focus on one important thing.', unit='minutes', daily_goal=60, weekly_target=5),
    T('inbox', 'Inbox to zero', '📥', 'productivity', 'check', 'Or at least to a list.', weekly_target=5, time_of_day='afternoon'),
    T('weekly-review', 'Weekly review', '🔁', 'productivity', 'check', 'Look back, look ahead, once a week.', weekly_target=1),
    T('no-snooze', 'Up at the first alarm', '⏰', 'productivity', 'check', 'No snooze.', weekly_target=5, time_of_day='morning'),
    # Money
    T('spending', 'Log spending', '🧾', 'money', 'check', 'Two minutes to write it all down.', time_of_day='evening'),
    T('no-spend', 'No-spend day', '💰', 'money', 'check', 'Nothing beyond the essentials.', weekly_target=2),
    T('save', 'Put something aside', '🏦', 'money', 'check', 'Any amount, into savings.', weekly_target=1),
    T('budget', 'Check the budget', '📊', 'money', 'check', 'Once a week is enough.', weekly_target=1),
    # Home
    T('tidy', 'Ten-minute tidy', '🧹', 'home', 'duration', 'Set a timer, stop when it goes.', unit='minutes', daily_goal=10, weekly_target=5, time_of_day='evening'),
    T('bed', 'Make the bed', '🛏️', 'home', 'check', 'An easy first win.', time_of_day='morning'),
    T('dishes', 'Dishes done before bed', '🍽️', 'home', 'check', 'Wake up to a clear kitchen.', time_of_day='evening'),
    T('plants', 'Water the plants', '🪴', 'home', 'check', 'A couple of times a week, or whatever they ask for.', weekly_target=2),
    T('laundry', 'A load of laundry', '🧺', 'home', 'check', 'Before it becomes a mountain.', weekly_target=2),
    T('declutter', 'Declutter one thing', '📦', 'home', 'check', 'Give, sell or recycle.', weekly_target=3),
    # Breaking a habit
    T('no-smoking', 'Smoke-free', '🚭', 'break', 'quit', 'Log a slip if it happens and carry on. Support makes quitting far more likely to stick.'),
    T('no-vaping', 'Vape-free', '💨', 'break', 'quit', 'Log a slip if it happens and carry on.'),
    T('less-alcohol', 'Alcohol-free day', '🍷', 'break', 'quit', "Set how many alcohol-free days a week you're aiming for.", weekly_target=5),
    T('no-doomscroll', 'No doom-scrolling', '📱', 'break', 'quit', 'A slip is scrolling past the point you meant to stop.'),
    T('social-media', 'Social media only on purpose', '🔕', 'break', 'quit', 'Open it to do something, then close it.', weekly_target=5),
    T('late-caffeine', 'No caffeine after 2pm', '☕', 'break', 'quit', 'For better sleep.', weekly_target=5),
    T('sugary-drinks', 'No sugary drinks', '🥤', 'break', 'quit', 'Water, tea or coffee instead.', weekly_target=5),
    T('nail-biting', 'No nail-biting', '💅', 'break', 'quit', "Notice the moment it starts; that's most of the work."),
    T('late-snacking', 'Kitchen closed after dinner', '🌜', 'break', 'quit', 'A calm evening routine, not a rule about food.', weekly_target=5),
    T('gambling', 'Gamble-free', '🎲', 'break', 'quit', 'Log a slip if it happens and carry on. Free, confidential support exists.'),
    T('porn', 'Porn-free', '🔒', 'break', 'quit', 'Log a slip if it happens and carry on.'),
    T('swearing', 'Swear less', '🤐', 'break', 'quit', 'A slip is a day it got away from you.', weekly_target=5),
)
# fmt: on

TEMPLATE_BY_ID = {t.id: t for t in TEMPLATES}


def catalog_payload() -> dict:
    return {
        "categories": CATEGORIES,
        "templates": [asdict(t) for t in TEMPLATES],
    }
