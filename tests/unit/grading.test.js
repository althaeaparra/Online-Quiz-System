import { gradeAnswer, buildStudentView } from '../../services/quizService.js';

const mc = {
  type: 'multiple_choice',
  options: [{ text: 'Mars' }, { text: 'Venus' }, { text: 'Jupiter' }],
  correctAnswer: 0,
};

describe('gradeAnswer', () => {
  test('multiple choice accepts indexes and option text', () => {
    expect(gradeAnswer(mc, 0).isCorrect).toBe(true);
    expect(gradeAnswer(mc, '0').isCorrect).toBe(true);
    expect(gradeAnswer(mc, 1).isCorrect).toBe(false);
    expect(gradeAnswer(mc, 'Mars').isCorrect).toBe(true);
    expect(gradeAnswer(mc, 'Venus').isCorrect).toBe(false);
  });

  test('multiple choice supports multiple correct answers', () => {
    const multi = { ...mc, correctAnswer: [0, 2] };
    expect(gradeAnswer(multi, [0, 2]).isCorrect).toBe(true);
    expect(gradeAnswer(multi, [2, 0]).isCorrect).toBe(true);
    expect(gradeAnswer(multi, [0]).isCorrect).toBe(false);
    expect(gradeAnswer(multi, [0, 1]).isCorrect).toBe(false);
  });

  test('true/false normalises strings and booleans', () => {
    const q = { type: 'true_false', correctAnswer: true };
    expect(gradeAnswer(q, true).isCorrect).toBe(true);
    expect(gradeAnswer(q, 'true').isCorrect).toBe(true);
    expect(gradeAnswer(q, false).isCorrect).toBe(false);
    expect(gradeAnswer(q, 'false').isCorrect).toBe(false);
  });

  test('short answer is case and punctuation insensitive', () => {
    const q = { type: 'short_answer', correctAnswer: ['Mercury', 'mercury planet'] };
    expect(gradeAnswer(q, '  mercury. ').isCorrect).toBe(true);
    expect(gradeAnswer(q, 'MERCURY').isCorrect).toBe(true);
    expect(gradeAnswer(q, 'Venus').isCorrect).toBe(false);
  });

  test('essay answers are always queued for manual grading', () => {
    const result = gradeAnswer({ type: 'essay', correctAnswer: null }, 'A long thoughtful answer');
    expect(result).toEqual({ isCorrect: null, needsManualGrading: true });
  });

  test('blank answers never score', () => {
    expect(gradeAnswer(mc, null).isCorrect).toBe(false);
    expect(gradeAnswer(mc, '').isCorrect).toBe(false);
    expect(gradeAnswer({ type: 'true_false', correctAnswer: true }, undefined).isCorrect).toBe(false);
  });
});

describe('buildStudentView', () => {
  const quiz = {
    _id: '65f1c2a9e4b0a1b2c3d4e5f6',
    title: 'Demo',
    settings: { timePerQuestion: 30, randomizeQuestions: true, randomizeOptions: true, passingScore: 60 },
    category: { _id: '65f1c2a9e4b0a1b2c3d4e5f7', name: 'Science' },
    questions: [
      {
        _id: '65f1c2a9e4b0a1b2c3d4e5f8',
        type: 'multiple_choice',
        question: 'Pick one',
        options: [{ text: 'A' }, { text: 'B' }],
        correctAnswer: 1,
        points: 5,
        explanation: 'Because B',
      },
    ],
  };

  test('never leaks answer keys or explanations', () => {
    const view = buildStudentView(quiz, { seed: 'abc', shuffleQuestions: false, shuffleOptions: false });
    const serialised = JSON.stringify(view);

    expect(serialised).not.toContain('correctAnswer');
    expect(serialised).not.toContain('Because B');
    expect(view.questions[0]).toMatchObject({ type: 'multiple_choice', points: 5 });
    expect(view.totalPoints).toBe(5);
  });

  test('shuffled options keep their original indexes', () => {
    const view = buildStudentView(
      {
        ...quiz,
        questions: [
          {
            ...quiz.questions[0],
            options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }],
          },
        ],
      },
      { seed: 'stable-seed', shuffleQuestions: false, shuffleOptions: true },
    );

    const indexes = view.questions[0].options.map((o) => o.index).sort();
    expect(indexes).toEqual([0, 1, 2, 3]);
  });

  test('true/false questions get standard options', () => {
    const view = buildStudentView(
      {
        ...quiz,
        questions: [{ _id: '65f1c2a9e4b0a1b2c3d4e5f9', type: 'true_false', question: 'Sky is blue?', correctAnswer: true, points: 1 }],
      },
      { seed: 'x' },
    );

    expect(view.questions[0].options).toEqual([
      { index: true, text: 'True' },
      { index: false, text: 'False' },
    ]);
  });
});
