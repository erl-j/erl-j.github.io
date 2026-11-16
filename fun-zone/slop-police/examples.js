/* Example texts for the page. The first two were written by src/page_bands.py (v2 TRAIN only);
   the two Claude texts (train_id null) were added by hand: fresh model output on the same topic
   as the human example, not from the training data, facts unchecked. Re-running page_bands.py
   overwrites this file. Licences and attribution are shown on the page; see docs/PAGE.md. */
globalThis.SLOP_EXAMPLES = [
 {
  "key": "human",
  "label": "Human, pre-2022 (Wikipedia)",
  "text": "Early career\nBuckstone first joined a travelling troupe in 1821 as Gabriel in The Children in the Wood. and toured for three years, mostly in the southeast of England. He found a mentor in Edmund Kean. He made his first London appearance, on 30 January 1823, at the Surrey Theatre, as Ramsay in The Fortunes of Nigel. In 1824 he joined that theatre and played Peter Smink in The Armistice with great success. He also began to write plays.\n\nHis successes led to his engagement in 1827 at the Adelphi Theatre, where he remained as the leading low comedian until 1833. Buckstone's acting was described as \"a union of shrewdness and drollery, with their interaction upon each other... was irresistibly comic.\" Buckstone wrote most of his plays in the first half of his career, and many of these were produced at the Adelphi. As his acting career reached the height of its success, his playwriting output declined. At the Adelphi, he appeared as Bobby Trot in his first really successful play, the melodrama Luke the Labourer (1827), which he had written in 1826. Other well known plays were Wreck Ashore (1830) and Forgery (1832) Perhaps the most successful of these early plays was his 1833 play, The Bravo, based on James Fenimore Cooper's novel of the same name.\n\nPeak years\nHe first appeared at the Haymarket Theatre during the summer season in 1833, also writing plays for this theatre, including Ellen Wartham (1833). Another hit for the Haymarket was the drama Thirty Years of a Woman's Life. At that theatre, his acting was praised in The Housekeeper by Douglas Jerrold (1833), Pyramus and Thisbe, and in his own plays, Uncle John, Rural Felicity and Agnes de Vere (all in 1834).",
  "train_id": "wiki0132-h",
  "oof_p": 0.005359220727655437,
  "class_median": 0.05280058007914272,
  "attribution": "Wikipedia, “John Baldwin Buckstone”, revision 1044369277 (2021-09-14), text converted from the rendered page. CC BY-SA 4.0. Contributors: see the article history.",
  "url": "https://en.wikipedia.org/w/index.php?oldid=1044369277",
  "licence": "CC BY-SA 4.0"
 },
 {
  "key": "ai",
  "label": "Model answer (DeepSeek-V4-Pro)",
  "text": "It's because the monk who invented the Anno Domini system, Dionysius Exiguus, just botched the arithmetic. He was trying to chuck the old calendar based on the Emperor Diocletian (a real piece of work to Christians) and start counting from the year Jesus became flesh. But he never laid out his working, and the history he had was spotty at best. The Gospels put Jesus's birth during the reign of Herod the Great. Josephus, writing not long after, ties Herod's death to a lunar eclipse and other events that lock it to 4 BC. If Herod was alive to pull that stunt with the infants in Bethlehem, Jesus couldn't have been born later than that, 4 BC is the terminus, and most scholars push it back to 6 or 5 BC. Dionysius either forgot Herod or simply didn't know.\n\nHis calendar spread slowly, and by the time the Venerable Bede made it standard, nobody remembered the mismatch. I have to laugh when Google spits out \"4 BC\" like it's a fix, because we're stuck with a global dating scaffold that's just *wrong by design*. What really gets me is the system has *no Year 0*, 1 BC jumps straight to AD 1, so the century arithmetic is always a bit cockeyed. So when you see that date, it's historians forcing an event into a box that doesn't even fit itself. You'd think someone would have picked a less embarassing epoch, but here we are, using a calendar built on a bad guess and a missing zero. Do you ever stare at a gregorian calendar and wonder what other foundational stuff is held together with spit?",
  "train_id": "eli50283-a",
  "oof_p": 0.9349368483256588,
  "class_median": 0.9343615939341585,
  "attribution": "DeepSeek-V4-Pro answer to an ELI5 question, from the mild-rgb eli5-human-vs-ai dataset (rev ce97b32a), generated with an “avoid AI tells” prompt. CC BY 4.0.",
  "url": "https://huggingface.co/datasets/mild-rgb/eli5-human-vs-ai",
  "licence": "CC BY 4.0"
 },
 {
  "key": "haiku",
  "label": "Claude Haiku (same topic as the human example)",
  "text": "John Baldwin Buckstone (1802–1879) began his career in the theatre at a young age, first gaining experience as a child performer and then working in a variety of minor roles and provincial companies. Born in London, he initially sought work on the stage without the benefit of formal training, and his early years were marked by modest engagements and a gradual development of his skills as a comic actor. He eventually found steady work in London's theatres, where his talent for light comedy and character parts began to attract attention. These formative years laid the groundwork for his later prominence as both an actor and a manager.\n\nAs his reputation grew, Buckstone turned increasingly toward writing, producing a large number of farces, comedies, and melodramas that were staged to considerable popular success. His playwriting complemented his acting, as he often wrote roles suited to his own comic persona, and this combination helped him secure a more prominent position in the London theatre world. Over time he became associated with the Haymarket Theatre, which he eventually managed for decades, becoming one of the most recognizable figures in mid-nineteenth-century English theatre. His early career thus shaped the versatile, practical approach to the stage that defined his later life and work.",
  "train_id": null,
  "attribution": "Fresh output from Claude Haiku, generated for this page on the same topic as the human example (the early career of John Baldwin Buckstone). Not from the training data; its facts have not been checked.",
  "url": "",
  "licence": ""
 },
 {
  "key": "sonnet",
  "label": "Claude Sonnet (same topic as the human example)",
  "text": "John Baldwin Buckstone was born in London in 1802, the son of a ship-owner's family, and was initially destined for a conventional career. He was educated in Hampstead and then placed in a solicitor's office, but his enthusiasm for the theatre soon outweighed any interest in the law. He began performing in amateur theatricals and made his professional debut in 1821 at the Surrey Theatre in London, where he rapidly found his footing in comic roles. His talent for broad, good-humoured comedy, along with a flair for stage business, quickly won him notice among audiences and managers.\n\nBuckstone's early career was marked by remarkable productivity as both performer and writer. His first play, *The Rival Theatres*, appeared in 1823, and he went on to write a great many farces, melodramas and comedies, with *Luke the Labourer* (1826) among the early successes that established his reputation as a dramatist. He worked at several London houses, including the Adelphi, where he became a popular comedian and built a long association with the company there. Writing for himself and his fellow actors, he produced pieces at a prodigious rate, and by the 1830s he was among the most prolific and recognizable figures of the London stage, a foundation that later led to his long tenure as manager of the Haymarket Theatre.",
  "train_id": null,
  "attribution": "Fresh output from Claude Sonnet, generated for this page on the same topic as the human example (the early career of John Baldwin Buckstone). Not from the training data; its facts have not been checked.",
  "url": "",
  "licence": ""
 }
];
