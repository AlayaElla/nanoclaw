const card = {
  header: {
    template: 'blue',
    title: { tag: 'plain_text', content: '❓ Question' }
  },
  elements: [
    {
      tag: 'markdown',
      content: 'Description'
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Option 1' },
          type: 'default',
          value: { questionId: '123', index: 0 }
        }
      ]
    }
  ]
};
console.log(JSON.stringify(card, null, 2));
