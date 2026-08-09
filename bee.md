# Goal
The goal is to create a slick, modern web application that can help students prepare for history bee/history bowl competitions and history championship exams. The application should be easily run in windows or Mac, or be deployed into the cloud.

The task can be divided into two parts: The web crawling part to generate the test bank, and the web application part that the student can use to practice.

# Requirements for the web application:

It should be able to test the student with either multiple choice exams, or Buzzer-Based Quiz Competitions, based on what the student chose.

## Multiple-choice questions
Multiple-choice questions from the National History Bee Online Regional Qualifying Exam tests fundamental historical knowledge.

Here are example multiple-choice questions tailored for the Middle School division of the National History Bee. These questions reflect the typical distribution of U.S. and World History topics tested at this level.

Question 1: U.S. History
Which standard United States military rifle, adopted in 1936, was famously praised by General George S. Patton as "the greatest battle implement ever devised" during World War II?
A. M1 Garand
B. M1903 Springfield
C. M1 Carbine
D. Thompson Submachine Gun
Correct Answer: A. M1 Garand

Question 2: World History
Which absolute monarch of France, known as the "Sun King," consolidated royal power by forcing the nobility to reside with him at his massive Palace of Versailles?
A. Louis XIV
B. Louis XVI
C. Henry IV
D. Charlemagne
Correct Answer: A. Louis XIV

Question 3: Ancient History
What specialized system of writing, consisting of wedge-shaped marks pressed into wet clay tablets, was developed by the ancient Sumerians of Mesopotamia?
A. Hieroglyphics
B. Cuneiform
C. Linear B
D. Phoenician Alphabet
Correct Answer: B. Cuneiform

## Buzzer-based History Bee questions
Buzzer-based History Bee questions (such as those run by International Academic Competitions) use a pyramidal tossup structure. This means a paragraph-length question begins with obscure, hard-to-guess historical clues and progressively moves toward easier, more well-known facts. 

Pyramidal Question Flow

The Lead-in (Clues 1-2): Highly obscure facts, early life details, minor battles, or lesser-known works. Only top experts or those taking a massive gamble will buzz in here. 

The Middle (Clues 3-4): Moderately difficult historical context, major turning points, or regional associations. Most successful buzzes happen in this window. 

The Giveaway (Final Clue): Broad, highly recognizable facts or famous definitions that an average student in that age division should easily identify if nobody has buzzed yet.

Here are a few examples:

1. History Bee Middle School

This empire was governed by the Gbara, which drew delegates from its territories across the “Twelve Doors”. According to myth, a rooster-tipped arrow allowed this empire to win the Battle of Kirina. A ruler of this empire allegedly devalued gold throughout North Africa with his lavish gifts while on a hajj to Mecca. For the point, name this West African empire that was supplanted by the Songhai and was once ruled by Mansa Musa. 
ANSWER: Mali Empire

2. History Bee High School

This country	  took	  five	  boats	  from	  a	  French	  port	  in	  the	  Cherbourg	  Project.	  France	  had	  refused to	   deliver	   the	   boats,	   for	  which	   this	   country	   had	   paid,	  when	   diplomatic	   relations	   broke	  after	   the	  Six-­‐Day	   War.	   Operation	   Wrath	   of	   God	   was	   launched	   after	   11	   members	   of	   this	   country’s	   Olympic	   team	   were	   killed	   in	   1972.	   For	   the	   point,	   name	   this	   Middle	   Eastern	   country	   that	   carried	   out	   those	   missions	   via	   Mossad,	  an	  intelligence	  agency	  that	  reports	  to	  Prime	  Minister	  Benjamin	  Netanyahu. 
ANSWER:	  Israel

## Other requirements

1. Buzz quzz question is main test method. Buzz question should show or read the lead-in, the middle, and the giveaway one at a time. The student should be able to answer in voice. Still finish the question and give the answer with explanation if student didn’t get it right 30 seconds after the question was read out completely.

2. Provide a student dashboard for all the practice history and results. Save Wrong questions for retaking, and provide new questions on topics answered wrong.

3. Have the option to quiz by official past questions or app generated question. Has option for different difficulty level. Option to format as multiple choice or buzz base. Option to choice the category to test on.

4. Have the options to upload more documentation like PDF, Word or add more links in addition to the resources already provided. Save the content into the test bank for future uses. 

5. Based on test the results, identify week point and generate test for the area that needs more study, also suggest online resources for further study.

# Requirements for the web crawler to build the test bank
Based on end-user requirement and functionalities specified above, create an application that:

1. Create a test bank based on official past questions. Crawl all the links and files on the webpages for embedded content. Links could lead to word documents, pdf file with links, or webpage with more links. The test bank should contain both muiltiple choice questions and Buzzer-based History Bee questions.

2. Generate questions based on official question structure, study guides, history general topics and other history related online websites. Mark these questions as generated, not official. Generate the test set with thorough explanation for each questions. Add these questions to the test bank.  

3. Add categories to each question in order to have the choice to test on specific history categories. For example: US history, European history, Ancient World, Middle Ages, Renaissance, Exploration, Revolutions, World Wars, Empires, Leaders, Religions, Art history, sports history, literature history, science history, mythology, historical geography, politics etc. each question should have multiple applicable tags.

4. Crawl the web for contents. Useful materials includ:
- official competition material links
- Current and past Study guides
- Past questions and exams
- Sample questions exams
- General history topics file
- The following web sites
https://iacompetitionsasia.com/history-bee-bowl-practice-materials/
https://www.ihbbeurope.com/resources/
https://www.historyolympiad.com/resources/
https://www.iacompetitions.com/study-guides/
https://quizbowlpackets.com/
https://www.iacompetitions.com/resources-national-history-bee/
https://www.iacompetitions.com/ems-national-history-bee-past-questions/
https://www.iacompetitions.com/resources-national-history-bowl/
https://www.iacompetitions.com/ems-national-history-bowl/
https://www.iacompetitions.com/exams/

Example of Other useful websites for detailed history content:
https://www.britannica.com/History-Society
https://www.worldhistory.org
https://millercenter.org

5. Choose appropriate database or storage technology and format for the test bank as you wish.

# Deployment
Both applications should be deployable inside docker.