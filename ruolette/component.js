let sum = 0

setInterval(() => {
  function getRandomNum1(min, max) {
    const randRotate = Math.floor(Math.random() * (max - min + 1) + min)
    sum = sum + randRotate
    return randRotate * 5
  }

  const ranVal = getRandomNum1(180,360)
  // $circle.style.transition = '10s ease'
  // $circle.style.transform = `rotate(${ranVal}deg)`
  console.log(ranVal)
  setTimeout(() => {
    // $circle.style.transform = `rotate(${ranVal / 5}deg)`
  },10100)
}, 1000)